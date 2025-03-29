require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// XML işleme fonksiyonları
async function getUrlsFromXml(xmlUrl) {
    try {
        const response = await axios.get(xmlUrl);
        const $ = cheerio.load(response.data, { xmlMode: true });
        const urls = [];
        $('url > loc').each((i, elem) => {
            urls.push($(elem).text());
        });
        return urls;
    } catch (error) {
        console.error('XML URL\'leri alınırken hata:', error);
        return [];
    }
}

async function scrapeProduct(url) {
    try {
        const response = await axios.get(url);
        const $ = cheerio.load(response.data);
        
        const name = $('h1.title').text().trim();
        const stockText = $('span.text-success').text().trim();
        const stock = stockText.includes('+') ? stockText.split('+')[0] : 
                     stockText.toLowerCase().includes('stokta yok') ? '0' : stockText;
        
        if (stock === '0') return null;

        const listPrice = $('div.list-price.sale-list-price').text().trim();
        const salePrice = $('div.sale-price.sale-variant-price').text().trim();
        const productCode = $('span.code-area-value').text().trim();
        const category = $('span.product-info-name:contains("Kategori") + span.value').text().trim();

        // Renk ve beden bilgilerini al
        const colors = [];
        const sizes = [];
        
        $('li.variant').each((i, elem) => {
            const name = $(elem).find('div.name').text();
            if (name.includes('RENK')) {
                $(elem).find('option[data-variant-value]').each((j, opt) => {
                    colors.push($(opt).attr('data-variant-value'));
                });
            } else if (name.includes('BEDEN')) {
                $(elem).find('option[data-variant-value]').each((j, opt) => {
                    sizes.push($(opt).attr('data-variant-value'));
                });
            }
        });

        // Görselleri al
        const imageUrls = [];
        $('div.carousel-item a').each((i, elem) => {
            const imgSrc = $(elem).attr('href');
            if (imgSrc && !imgSrc.startsWith('data:image')) {
                imageUrls.push(imgSrc);
            }
        });

        // Ürün verisini oluştur
        const productData = {
            url: url,
            product_code: `SKU-${productCode}`,
            barcode: generateBarcode(name),
            main_category: "Ev Giyim",
            top_category: "Şortlu Takım",
            sub_category: "",
            sub_category_2: "",
            category_id: "11",
            category: category,
            brand_id: "1",
            brand: "ENMADAM",
            name: name,
            description: "",
            image_1: imageUrls[0] || "",
            image_2: imageUrls[1] || "",
            image_3: imageUrls[2] || "",
            image_4: imageUrls[3] || "",
            image_5: imageUrls[4] || "",
            listPrice: listPrice,
            sitePrice: salePrice,
            price: salePrice,
            tax: "0.1",
            currency: "TRY",
            realListPrice: listPrice,
            realSitePrice: salePrice,
            realPrice: salePrice,
            realCurrency: "TL",
            desi: "1",
            domestic: "0",
            show_home: "1",
            in_discount: "1",
            quantity: stock,
            variants: []
        };

        // Varyantları ekle
        colors.forEach(color => {
            sizes.forEach(size => {
                productData.variants.push({
                    name1: "Beden",
                    value1: size,
                    name2: "Renk",
                    value2: color,
                    quantity: stock,
                    barcode: generateBarcode(`${name}-${color}-${size}`)
                });
            });
        });

        return productData;
    } catch (error) {
        console.error(`Ürün bilgileri alınırken hata: ${url}`, error);
        return null;
    }
}

function generateBarcode(str) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 12).toUpperCase();
}

async function createXml(products) {
    const builder = new xml2js.Builder();
    const xml = builder.buildObject({ products: { product: products } });
    await fs.writeFile('urunler2.xml', xml);
}

async function loadExistingXml(filePath) {
    try {
        const xmlData = await fs.readFile(filePath, 'utf-8');
        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(xmlData);
        return result.products.product;
    } catch (error) {
        console.error('XML dosyası okunurken hata:', error);
        return [];
    }
}

async function updateProductStocks() {
    try {
        // Mevcut XML'i yükle
        const existingProducts = await loadExistingXml('urunler.xml');
        
        // Sitemap'ten URL'leri al
        const xmlUrl = "https://www.enmadam.com/sitemap/products/1.xml";
        const urls = await getUrlsFromXml(xmlUrl);
        
        // Her URL için ürün bilgilerini al
        const newProducts = [];
        for (const url of urls) {
            const product = await scrapeProduct(url);
            if (product) {
                newProducts.push(product);
            }
        }

        // Yeni XML'i oluştur
        await createXml(newProducts);

        // Stok güncellemelerini yap
        const updatedProducts = existingProducts.map(existingProduct => {
            const newProduct = newProducts.find(p => p.barcode === existingProduct.barcode);
            if (newProduct) {
                existingProduct.quantity = newProduct.quantity;
                if (existingProduct.variants && newProduct.variants) {
                    existingProduct.variants.forEach(variant => {
                        const newVariant = newProduct.variants.find(v => v.barcode === variant.barcode);
                        if (newVariant) {
                            variant.quantity = newVariant.quantity;
                        }
                    });
                }
            }
            return existingProduct;
        });

        // Güncellenmiş XML'i kaydet
        await createXml(updatedProducts);
        console.log('Stoklar başarıyla güncellendi.');

    } catch (error) {
        console.error('Stok güncelleme işlemi sırasında hata:', error);
    }
}

// Routes
app.get('/', (req, res) => {
  res.json({ message: 'Hoş geldiniz!' });
});

app.post('/update-stocks', async (req, res) => {
    try {
        await updateProductStocks();
        res.json({ message: 'Stok güncelleme işlemi tamamlandı.' });
    } catch (error) {
        res.status(500).json({ error: 'Stok güncelleme işlemi başarısız oldu.' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Bir şeyler ters gitti!' });
});

// Start server
app.listen(port, () => {
  console.log(`Server ${port} portunda çalışıyor`);
}); 