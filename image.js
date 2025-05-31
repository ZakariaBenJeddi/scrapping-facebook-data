const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const https = require('https');
const path = require('path');

// ============= CONFIGURATION =============
const CONFIG = {
  // Nombre d'URLs à traiter en parallèle
  BATCH_SIZE: 5,
  
  // Timeout pour les téléchargements (en ms)
  DOWNLOAD_TIMEOUT: 30000,
  
  // Dossier de téléchargement
  DOWNLOAD_FOLDER: './images',
  
  // Formats d'images supportés
  SUPPORTED_FORMATS: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'],
  
  // Taille minimale d'image (en bytes) - évite les miniatures
  MIN_FILE_SIZE: 10000, // 10KB
  
  // Options du navigateur
  BROWSER_OPTIONS: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
};

/**
 * Détecte le format d'image depuis l'URL ou les headers
 * @param {string} url - URL de l'image
 * @param {Object} headers - Headers HTTP
 * @returns {string} Extension du fichier
 */
function detectImageFormat(url, headers = {}) {
  // Essayer de détecter depuis l'URL
  const urlPath = new URL(url).pathname.toLowerCase();
  for (const format of CONFIG.SUPPORTED_FORMATS) {
    if (urlPath.includes(format)) {
      return format;
    }
  }
  
  // Essayer de détecter depuis le Content-Type
  const contentType = headers['content-type'] || '';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('bmp')) return '.bmp';
  
  // Par défaut
  return '.jpg';
}

/**
 * Télécharge une image depuis une URL
 * @param {string} url - URL de l'image à télécharger
 * @param {string} filename - Nom du fichier de destination
 * @returns {Promise<Object>} Résultat du téléchargement
 */
async function downloadImage(url, filename) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout de téléchargement'));
    }, CONFIG.DOWNLOAD_TIMEOUT);

    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timeout);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      // Vérifier si c'est bien une image
      const contentType = response.headers['content-type'] || '';
      if (!contentType.startsWith('image/')) {
        clearTimeout(timeout);
        reject(new Error('Le contenu n\'est pas une image'));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      const chunks = [];

      response.on('data', (chunk) => {
        chunks.push(chunk);
        downloadedSize += chunk.length;
        
        if (totalSize) {
          const progress = Math.round((downloadedSize / totalSize) * 100);
          process.stdout.write(`\r🖼️ ${path.basename(filename)}: ${progress}%`);
        }
      });

      response.on('end', async () => {
        clearTimeout(timeout);
        
        // Vérifier la taille minimale
        if (downloadedSize < CONFIG.MIN_FILE_SIZE) {
          reject(new Error(`Image trop petite (${downloadedSize} bytes)`));
          return;
        }

        try {
          // Détecter le bon format et ajuster le nom de fichier
          const detectedFormat = detectImageFormat(url, response.headers);
          const finalFilename = filename.replace(/\.[^.]+$/, detectedFormat);
          
          // Sauvegarder l'image
          const buffer = Buffer.concat(chunks);
          await fs.writeFile(finalFilename, buffer);
          
          console.log(`\n✅ Image téléchargée: ${path.basename(finalFilename)}`);
          resolve({
            success: true,
            filename: finalFilename,
            size: downloadedSize,
            format: detectedFormat,
            dimensions: await getImageDimensions(buffer),
            url: url
          });
          
        } catch (error) {
          reject(error);
        }
      });

      response.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Obtient les dimensions d'une image depuis son buffer (basique)
 * @param {Buffer} buffer - Buffer de l'image
 * @returns {Object} Dimensions ou null
 */
async function getImageDimensions(buffer) {
  try {
    // Détection basique pour JPEG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      // Parcourir les segments JPEG pour trouver SOF
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] === 0xFF) {
          const marker = buffer[offset + 1];
          if (marker >= 0xC0 && marker <= 0xC3) {
            const height = buffer.readUInt16BE(offset + 5);
            const width = buffer.readUInt16BE(offset + 7);
            return { width, height };
          }
          const length = buffer.readUInt16BE(offset + 2);
          offset += length + 2;
        } else {
          offset++;
        }
      }
    }
    
    // Détection basique pour PNG
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Vérifie si une URL d'image est encore valide
 * @param {string} url - URL à vérifier
 * @returns {Promise<Object>} Informations sur la validité
 */
async function checkImageUrlValidity(url) {
  return new Promise((resolve) => {
    https.get(url, { method: 'HEAD' }, (response) => {
      const contentType = response.headers['content-type'] || '';
      const contentLength = parseInt(response.headers['content-length'], 10) || 0;
      
      resolve({
        isValid: response.statusCode === 200,
        isImage: contentType.startsWith('image/'),
        contentType: contentType,
        size: contentLength,
        statusCode: response.statusCode
      });
    }).on('error', () => {
      resolve({
        isValid: false,
        isImage: false,
        error: 'Erreur de connexion'
      });
    });
  });
}

/**
 * Traite une URL d'image Facebook
 * @param {string} url - URL Facebook à traiter
 * @param {number} index - Index de l'URL dans la liste
 * @returns {Promise<Object>} Résultat du traitement
 */
async function processFacebookImageUrl(url, index) {
  const startTime = Date.now();
  
  try {
    console.log(`\n🔄 Traitement ${index + 1}: ${url.substring(0, 80)}...`);
    
    // Vérifier la validité de l'URL
    console.log('🔍 Vérification de la validité...');
    const urlCheck = await checkImageUrlValidity(url);
    
    if (!urlCheck.isValid) {
      return {
        url: url,
        index: index + 1,
        success: false,
        error: `URL inaccessible (${urlCheck.statusCode || 'erreur réseau'})`,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
    
    if (!urlCheck.isImage) {
      return {
        url: url,
        index: index + 1,
        success: false,
        error: `Le contenu n'est pas une image (${urlCheck.contentType})`,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
    
    if (urlCheck.size && urlCheck.size < CONFIG.MIN_FILE_SIZE) {
      return {
        url: url,
        index: index + 1,
        success: false,
        error: `Image trop petite (${urlCheck.size} bytes)`,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
    
    // Créer le nom de fichier
    const urlObj = new URL(url);
    const imageId = urlObj.pathname.split('/').pop().split('.')[0] || `image_${Date.now()}`;
    const baseFilename = `facebook_image_${index + 1}_${imageId}`;
    const filename = path.join(CONFIG.DOWNLOAD_FOLDER, `${baseFilename}.tmp`);
    
    // Télécharger l'image
    console.log('🖼️ Début du téléchargement...');
    const downloadResult = await downloadImage(url, filename);
    
    return {
      url: url,
      index: index + 1,
      success: true,
      filename: downloadResult.filename,
      fileSize: downloadResult.size,
      format: downloadResult.format,
      dimensions: downloadResult.dimensions,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`❌ Erreur pour l'URL ${index + 1}:`, error.message);
    
    return {
      url: url,
      index: index + 1,
      success: false,
      error: error.message,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Traite un lot d'URLs d'images en parallèle
 * @param {string[]} urlBatch - Lot d'URLs à traiter
 * @param {number} batchStartIndex - Index de début du lot
 * @returns {Promise<Object[]>} Résultats du lot
 */
async function processBatch(urlBatch, batchStartIndex) {
  const promises = urlBatch.map((url, i) => 
    processFacebookImageUrl(url, batchStartIndex + i)
  );
  return Promise.all(promises);
}

/**
 * Fonction principale de traitement des URLs d'images Facebook
 * @param {string[]} urls - Tableau des URLs d'images Facebook
 * @returns {Promise<Object>} Résultats complets
 */
async function processFacebookImages(urls) {
  console.log(`🚀 Démarrage du téléchargement de ${urls.length} images Facebook`);
  console.log(`📊 Configuration: ${CONFIG.BATCH_SIZE} images en parallèle`);
  console.log(`📁 Dossier de téléchargement: ${CONFIG.DOWNLOAD_FOLDER}`);
  console.log(`📏 Taille minimale: ${CONFIG.MIN_FILE_SIZE} bytes`);
  
  const results = [];
  const startTime = Date.now();
  
  try {
    // Créer le dossier de téléchargement
    await fs.mkdir(CONFIG.DOWNLOAD_FOLDER, { recursive: true });
    console.log(`📁 Dossier créé: ${CONFIG.DOWNLOAD_FOLDER}`);
    
    // Traitement par lots
    for (let i = 0; i < urls.length; i += CONFIG.BATCH_SIZE) {
      const batch = urls.slice(i, i + CONFIG.BATCH_SIZE);
      const batchNumber = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(urls.length / CONFIG.BATCH_SIZE);
      
      console.log(`\n📦 === LOT ${batchNumber}/${totalBatches} (${batch.length} images) ===`);
      
      const batchResults = await processBatch(batch, i);
      results.push(...batchResults);
      
      // Pause entre les lots
      if (i + CONFIG.BATCH_SIZE < urls.length) {
        console.log('\n⏸️ Pause de 2 secondes entre les lots...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
  } catch (error) {
    console.error('💥 Erreur critique:', error);
    throw error;
  }
  
  const endTime = Date.now();
  const duration = Math.round((endTime - startTime) / 1000);
  
  // Statistiques
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalSize = results.reduce((sum, r) => sum + (r.fileSize || 0), 0);
  
  // Statistiques par format
  const formatStats = {};
  results.filter(r => r.success).forEach(r => {
    formatStats[r.format] = (formatStats[r.format] || 0) + 1;
  });
  
  console.log('\n' + '='.repeat(50));
  console.log('📈 RÉSULTATS FINAUX:');
  console.log(`✅ Images téléchargées: ${successful}/${urls.length}`);
  console.log(`❌ Échecs: ${failed}/${urls.length}`);
  console.log(`💾 Taille totale: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`⏱️ Durée totale: ${duration}s`);
  console.log(`📊 Formats: ${Object.entries(formatStats).map(([format, count]) => `${format}: ${count}`).join(', ')}`);
  console.log('='.repeat(50));
  
  return {
    summary: {
      totalUrls: urls.length,
      successful,
      failed,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      duration: `${duration}s`,
      downloadFolder: CONFIG.DOWNLOAD_FOLDER,
      formatStats: formatStats,
      timestamp: new Date().toISOString()
    },
    results: results
  };
}

/**
 * Sauvegarde les résultats dans un fichier JSON
 * @param {Object} data - Données à sauvegarder
 * @param {string} filename - Nom du fichier (optionnel)
 */
async function saveResults(data, filename) {
  const defaultFilename = `facebook_images_results_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filepath = path.join(process.cwd(), filename || defaultFilename);
  
  try {
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 Résultats sauvegardés: ${filepath}`);
  } catch (error) {
    console.error('❌ Erreur lors de la sauvegarde:', error);
  }
}

// ============= VOS URLs D'IMAGES FACEBOOK =============
const FACEBOOK_IMAGE_URLS = [
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501798535_2057682678049726_1681851593248050537_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=UHRLprLFamAQ7kNvwH73PHa&_nc_oc=AdlaqbwxB75-yQNvr0vNhuWw5JijE5UI_UCVuu78RLXactDbZxmExkaniwTS2posHyQ&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=4w1nHq5wLIKkPS5PZEbDew&oh=00_AfLErOBquVj9SHLu9PNBaaqkxDmSznGlhHjKwIS-aHTGQA&oe=6840CEA6',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/502899559_737774255583039_3401129604571534161_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=U9-_WCi6hGkQ7kNvwEw8u3y&_nc_oc=AdnqVT46NSzRUYZYjAxMHMlU2jZBPNrEnLGNSyMaohBkYMTBsIn-wPraTFNzZTUhJ6Q&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=4w1nHq5wLIKkPS5PZEbDew&oh=00_AfJ-MqnQrtPqMcZVy3-jMpifXFxQ4y4fPEisdEUj_Ev7Jg&oe=6840CAC0',



'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500619228_1910167373073016_2121919389437015394_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=fhvu-84yXWMQ7kNvwHh7d2a&_nc_oc=AdlqHdMTFXHfIr29zq9oz7s63GeHdF8fr6OM6IWFmLPUwN8Y5HyHR55kXgbMKDa2xoo&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=4w1nHq5wLIKkPS5PZEbDew&oh=00_AfKDXIAib-ECHATYTLU6t8e3cV1TvLQDSb_G-mErcy_OAg&oe=6840DAC1',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500979556_23881592568102666_4455591527709106564_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=hC5fI0B2dvYQ7kNvwGLAfgW&_nc_oc=Adl6e_bQHoJFf8tYUov9b5exaueD6zZJ5IDfezWLvvWKzsyDQkFSqIX8mrL5E3yJYjs&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=4w1nHq5wLIKkPS5PZEbDew&oh=00_AfLDnJRuYSeOGdlCE-UQvtwLLpHa40EMt8DRFwgcLx85fA&oe=6840F671',

'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500974765_1356730738882231_841787111556849530_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=K_N9loMj3L4Q7kNvwGAIRdN&_nc_oc=AdmloQwatSTUBhqgWuZ9ajZTuNpD7otiUiCQ_OzdAVQhHwIHpKOqzq2dzdupKn9VHv0&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=4w1nHq5wLIKkPS5PZEbDew&oh=00_AfJUZhY4WBmCQQ1GBuiwPl5hfBhhQha1kBmuTpSQzl4ghg&oe=6840F449',










'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499891915_674168815484090_3009841361971983757_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=VZk-0LsAfmEQ7kNvwH7zawG&_nc_oc=AdkE3uSrE9AkFLlDVsJAoHjQ8qtFZFuWFvl2CMCdAUH9QWVEswc44ql37ppU_7wWreM&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfKqiepwN-bog52UXIJU853EuLzkrl6CzwRCZ6LpYqr4lQ&oe=6840F677',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/500229744_1143723301103255_9192260014929946362_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=95P7aJ4-q-4Q7kNvwGgnx2S&_nc_oc=AdlpPrh4qz4064aZBD59OlDNGiccrhzbhwdRWRB1qOB3JkO_RBKj16SvHdgfnqYZMiE&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfKB3AYPViCgVuu6AqhGezhYpO_3ay-v8-7czUzWzGpptQ&oe=6840F3C8',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499154641_1761585948124128_2936941840741610118_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qPTIAJlOoxQQ7kNvwFZI0zU&_nc_oc=AdlT6kbA4gL0pRTxCZnro21twjcvMlurH_gwvT2hUu8R2bjOAt2FHh1rC7C0P-qSydU&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfJSYL0nGVqWlRQPpME8dInOkvTt4kS3p1ag0LyZ99zcrA&oe=6840FD4E',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500224853_1066057678745757_2832744651772679210_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=p17-yR_-o4sQ7kNvwFB7qGd&_nc_oc=AdnSb7dUSQOODJhcZNFcjMZUuoF5doBP2JVPunWUx3U3o4rqJBTB0xgK9AS69BI_99A&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfJ9OdfZ9xlymZVnkfiyPaXgzTmB-ehl7ufVGTzu297F2A&oe=6840F976',


'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/499933223_1098230652231037_5690618053007233840_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=nRCdsOWbiw0Q7kNvwGjNSY-&_nc_oc=AdmlMTDspg18P-SmN6ScUzVLW3WNDodC_2_8tddwTcLAD7WlzTuQWEP9tu8KX4DiuR4&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfLpc0Ak6HJHolN2EXAUdLk3UREJivypNbHFs7Qsy1BX7w&oe=6840E91F',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/499722224_1125353939474543_6534314210933797504_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=_kC6sfUVyGIQ7kNvwEtLQP7&_nc_oc=Adm3bY3BPzezHhFMiOqLqQIJm1-O-B8Kd92t_RGyk57XdQPp2EWRSj5XRgds-HEr4ho&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfJpntL2TlQqZdKI22sgv4ALjjQpy4_xM7yEAz4mCji15w&oe=6840C97F',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499576229_1018713517075575_5499035728123300505_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=mTwoBPbwP8sQ7kNvwF8Mu6-&_nc_oc=AdlK38S-CFigjS_aWmF2oJscyHdP3C_ktAvrO1uV7-HhZSVNtYS1bEqkY6WmwceOE0Q&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfKxoec7BJh7L-PhewKjJzPVjyjud4Afd55I9KCZ_4y9qA&oe=6840F19E',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499847744_579140668109247_8433202669265494343_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=wxBYizDhseMQ7kNvwHMaOp-&_nc_oc=AdnPHmcDmrlNRnX8NMOnB7TDFmMiKnNQKu3pHvga9fqK-23cezzL36JP0SpWetS1v-E&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfIs1oa3_0Zl6sXN37pgajXnQcZrAl4-DLIu16zEdW3VrQ&oe=6840D58F',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499786380_3921410988110200_1490134657068279760_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=xpNGV8NplfcQ7kNvwHAi4Cy&_nc_oc=Adk-TTY_5hebhxc8NWV9fxq-C-1a2owGajl4jEDz4c5Sd8DWGoQYsVQX8tLp9QO5qsM&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfLuIALMziGrDaaLPqAH_GTPbM47lH3XvGyJMsjSN_WmUA&oe=6840DE82',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/498395730_3999774323579299_6964304187605145798_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=uucPl13Ph7wQ7kNvwH6qmDw&_nc_oc=AdmFeRMRAIA2ZspyzNeKP5XkIzraSpX20hbag_c440hGrSWs0Ln5uMyMqwasOiIXNE8&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfL_vjrEefyfEoaed6FL7aJ4DJkowcTbNpvTReg0sYF1MQ&oe=6840D7A9',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/498605037_2126570481100502_5347064513823131088_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=lyympc3ydi4Q7kNvwGgpw9m&_nc_oc=AdlmL-whA8nOmjr8F0xrX6Ab3lmhdNq5WOww7dNAG6xjbyiOLQL_eF9ow5eklxrj1VM&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfLBZQkJuBMwmXYi9JwFEEKJu83TueoopT0iDJr-_FqrZg&oe=6840C9D3',

'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/497576123_710893974830097_3770164972956168082_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rVzbS0pwAKAQ7kNvwFQE8uh&_nc_oc=AdmBZ-6TCom1ALyLo0aB5XT-bIeCo0lc1ZxKZ6bvA2iIsh9xFg9nEOBTv3Z7LzYhRjw&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=SI25tpCh-r0rkurmBp9Fdg&oh=00_AfJg6dDl2MCfjeBwVY8aEJHUxV76Rz8StooecgHAv86ZtA&oe=6840EBDC',









'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/478146596_1325730261911873_6176457404653182218_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QxuD69AhNbQQ7kNvwGgsjKS&_nc_oc=AdlCT0cCsm9FbF6GAbL11e1tLk7Hw4R_Zw6SDoWLAWVA9wMZaH2ze-1G7nHTfglBYFM&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=aZgXua_rxjpsQkvFjmB7xA&oh=00_AfL1LN0pD-JVtQ0Pov2a2HIm0GyBtyXby2MJdrZc73Tmyw&oe=6840DD7F',


'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473713120_9012961305448147_873647950264734092_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=sx89ROhu11oQ7kNvwFkpu1N&_nc_oc=Adkf_vuXkXlIVagQ6rhf4q6uGPnbUqleeKC7NqxAwcSzls3dYDGXieNmuZTvwXs5kXk&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=aZgXua_rxjpsQkvFjmB7xA&oh=00_AfLKfW9oelHpC0QlPE-_vxpxhhuSXhfyFwvaS4XUQl2rLw&oe=6840C9AD',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473221248_1605551616758330_8070596323176819918_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=AMYKlGUN4Y8Q7kNvwFD4_D8&_nc_oc=AdmRBc6A78qbtT8ueRSW7Vjc_IcVb-XG6MOzT0ngPMMxmY7BiL8Ewxvm--1HQxhAE7I&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=aZgXua_rxjpsQkvFjmB7xA&oh=00_AfLnEZKrSw1FQ9FRvFkJ24eKLnBD-D4TENKdroFQUU24ng&oe=6840F311',





















'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/502462904_3726951194262963_5028109530597460626_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QrjwTIHDtDoQ7kNvwHFY_x3&_nc_oc=Adm_jHbQhlVYcuKv1yxImnceQBb-rf0zoJJ1XGh3L192Ofe8Dc1IjKysmMzZWy7YdTc&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfLAv1cUzxE4anoj2KuT-ClKjsHBgHiiWi91GxojHmc0kg&oe=6840CE0F',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/502518658_1695793804385256_4718972883364433419_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=AEH6QIukzZIQ7kNvwHjVStf&_nc_oc=Adnl9aQMEhbegy5Bu6fQ6aweiLY6ZcPyPEdP4FXuoUJnPnwDu6SDqJyIM_X4EC4-nNI&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfKX05dyuV4IXbmbcixoKJe9oyxdfB18KCwTnI7Ce1FPAg&oe=6840DCBE',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500207342_706899135071389_6624566233038241147_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qQ8Qyzk027gQ7kNvwHtE4bV&_nc_oc=AdnsAkWaoIp99yil4pKZWXCmWt7fZXgSjxZaZH01pNNKEoAQhs1lfztjUiy_ZvG1xUo&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfLxFJe7miYGXn88e2SN7XmAXugZg11TjdyOC11fI8S8Nw&oe=6840DFF7',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500126229_1390495012259892_1247311902617128423_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=L59Sb_epqhMQ7kNvwGZZ_Qz&_nc_oc=Admv9pL3-UWpei_VXAzWCWkRdhcyvY6IYopciZOZYQtdmw7tV-2dj55WXohtsge5SJk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfLxB4tk_K2p6wveghIEVelP2wqGpeDlF4ESlWj0YqYQIA&oe=6840D6DA',

'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501039331_2212192375946478_3826197938590926462_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=xyZsG9FwdMQQ7kNvwFJNXuW&_nc_oc=Adl95bDRq0REL2iQPqo6YCwQ4FqldyYBIr3Wm4oLr-voERpuepxl2PVW81hqBM75gZY&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfLyMXa4h4BQdFDS9qhk0sDC6OscqmU_mjMEpGuN9BkUkw&oe=6840ED1B',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/499482843_544736308710033_7201633913811951013_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=YuGUnIMB0FgQ7kNvwE2cFwf&_nc_oc=Admt2Rq_M_nBpWKWQBLHJGHw4P0shfByuKnK2J0fSjmkPtZ68DuIja4-YWgiHahZqZ4&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfINxvIOf_1UCYFOCt853by5LtHn7jOSAJvagBhk_4wpJw&oe=6840ED03',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/495776621_1195559932250842_7092363957854391034_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=1x1GRyO8c78Q7kNvwGtu-5n&_nc_oc=AdnqrWPCX9-ZiDH914Cj4Iyx7fqtTc9OpuWp9PpsmhGMq0H_OfRWp0_h196tLb8SrTA&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfKQ_riHQmHsrtmai7gb4P6TGCA8a7V7T5OyoTfY2ybU5w&oe=6840E696',


'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/486778887_1297347564663930_7658458553959912708_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=2gCXats6uFQQ7kNvwE8Cslc&_nc_oc=AdkRina4Wks5t96TLgA1lvZfy_9H0a4r1-Q-MAh0gez1ElLamb8TJ8bDpU394suzTHE&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfKgWNilroV-sfarcGTvNkT6fidzag9ksBWxDOFievfYRQ&oe=6840E500',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/486647312_1367435258015159_6335917901326750316_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=PpV2Ex07LggQ7kNvwEBVlfT&_nc_oc=AdlnZwiRKhND_lG_66TM9XnbqCE1ap82KeeCFMF7b_0m5nrIRTz3kSDgTIqV7E_Wby0&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=aCGbbZ4u1w_7h1S_lPEpWA&oh=00_AfI_yszPqhoeUUavRlS28tVUkgrBQp3khHN4f2T0H1Qq9w&oe=6840D0AD',







'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/500103204_1193915162473582_4731556016032107937_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Wp2iYz9vTJUQ7kNvwE7Vnks&_nc_oc=Adkn_3vA4fntLRxXBwsdYILfCJC_aYzq225qkz2F7V3hoTASTcPlRDsAr0dqjk7APJs&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=hlrR0XTdlfVXM1kGKAl-iA&oh=00_AfLRHq7chqBurACzUxI4Ua_wCItwLhQSUnasgMByA7h7XQ&oe=6840F483',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500472777_668774546125105_6878003791159888650_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=0fHkSL-1ehkQ7kNvwGn20G6&_nc_oc=Admpx7uEjPfSVH3B_pBfkMXt49C_KEOOi17eVK2SuCIJLZOfhXsm_Q1qtWXHrekTz3k&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=hlrR0XTdlfVXM1kGKAl-iA&oh=00_AfJUj60vLdPwDeUigMO2UOV3mmTpQjAnGOOGwnUeEGeb9Q&oe=6840D62A',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/496926337_1247178983683439_7934725120214772989_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=_HSHjGVqAP0Q7kNvwEymdlq&_nc_oc=AdkJMPU18kSvjEuCIxj-XACwuzOPtvdQ6Bn5yaI8h2S7MVD6LAPyB7rk3Do4hIHz2Ig&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=hlrR0XTdlfVXM1kGKAl-iA&oh=00_AfJM9yJAXudqXnhmxNEWMMThfBqVHDN4-hv8NHwBWjrImg&oe=6840D205',



'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/491189249_1298989654496125_2024122113216544301_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=kRTbL0mB7-0Q7kNvwGYdOmo&_nc_oc=AdnKfZHPFYwpVro7yw2DPHWku6A0Q5BJ-Z_rYuW4XXCzTF_hvtaZvAdeicDBnZwL1ow&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=hlrR0XTdlfVXM1kGKAl-iA&oh=00_AfISGAB6nCs5DFqs6qImMEX9UFQndKBRDhmEzuKOKilkXw&oe=6840F6D1',





'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500765210_1653058885344143_8325928843539150743_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=NKICNNirhcEQ7kNvwGLncCr&_nc_oc=AdkmgpwLVpAcL9c6Wo61pIIXa6nQpM1rniDB3zIgEgXgXOEsQjIE2_Y73X0bX7snKvA&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=XvL6KonR51IFMLIQFZa47Q&oh=00_AfKWSj2gWcRUziIvYWHkU86AnLRE9YC8zLEae5B8kOkFtQ&oe=6840D00C',



'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/493303917_1813760235866863_2382908766612928274_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=x1k0SSdWMdcQ7kNvwHfWzrn&_nc_oc=AdnN9omkzueLH81g1ZxChZ0vAxiGmbFEQSJOKJ5TNBWr7ia6bWFsow0ZnV7W9sdJT2c&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=XvL6KonR51IFMLIQFZa47Q&oh=00_AfLN6cUXdizByGbqgXQonGBFAU79dlRrlLElMad6u3S3vQ&oe=684101E2',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/484919748_532380819880425_2886869660284142583_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=B8ziocNhYkQQ7kNvwEY7Z5H&_nc_oc=Admi8gzeLPxYEHQelbzeYisIrOi5gQo3C2rKVmiptj-xP1Ldb0wx1WocyOPP9z6y_dg&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=XvL6KonR51IFMLIQFZa47Q&oh=00_AfIpIULylHIfXpP45VLb7yeh769yacubroRPMc2bFpAYsw&oe=6840DA3D',


'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/497576123_710893974830097_3770164972956168082_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rVzbS0pwAKAQ7kNvwFQE8uh&_nc_oc=AdmBZ-6TCom1ALyLo0aB5XT-bIeCo0lc1ZxKZ6bvA2iIsh9xFg9nEOBTv3Z7LzYhRjw&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=njaew9NkDqobj8ZXqskLRg&oh=00_AfIvU6qg8DOxQBrOd4XY_10S85RxpNryJ-PUenEAlPwq1g&oe=6840EBDC',





'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/498395730_3999774323579299_6964304187605145798_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=uucPl13Ph7wQ7kNvwH6qmDw&_nc_oc=AdmFeRMRAIA2ZspyzNeKP5XkIzraSpX20hbag_c440hGrSWs0Ln5uMyMqwasOiIXNE8&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=VuFFc9KekP9mxBku9yBtzQ&oh=00_AfKuaiSMqR7HFeJQCHjbCHNqNpw1ec3J3w6ryyyM-t-JHw&oe=6840D7A9',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/498605037_2126570481100502_5347064513823131088_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=lyympc3ydi4Q7kNvwGgpw9m&_nc_oc=AdlmL-whA8nOmjr8F0xrX6Ab3lmhdNq5WOww7dNAG6xjbyiOLQL_eF9ow5eklxrj1VM&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=VuFFc9KekP9mxBku9yBtzQ&oh=00_AfKoAgraN0MfiIMoJcjSonsZR-WQBgZ_tiqASRRitlLgJg&oe=68410213',


'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500979556_23881592568102666_4455591527709106564_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=hC5fI0B2dvYQ7kNvwGLAfgW&_nc_oc=Adl6e_bQHoJFf8tYUov9b5exaueD6zZJ5IDfezWLvvWKzsyDQkFSqIX8mrL5E3yJYjs&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=tGGBlmCVkrj1vl20xY7sRw&oh=00_AfLcg54dSjpIbUHDT2aMwQIipkzp1wIxBizHr9RXCGfENg&oe=6840F671',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500126229_1390495012259892_1247311902617128423_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=L59Sb_epqhMQ7kNvwGZZ_Qz&_nc_oc=Admv9pL3-UWpei_VXAzWCWkRdhcyvY6IYopciZOZYQtdmw7tV-2dj55WXohtsge5SJk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=tGGBlmCVkrj1vl20xY7sRw&oh=00_AfLALZS2RJYh0b81-6ur2YV3SI7ewTVEJ2-05FXioyauhw&oe=6840D6DA',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/491189249_1298989654496125_2024122113216544301_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=kRTbL0mB7-0Q7kNvwGYdOmo&_nc_oc=AdnKfZHPFYwpVro7yw2DPHWku6A0Q5BJ-Z_rYuW4XXCzTF_hvtaZvAdeicDBnZwL1ow&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=tGGBlmCVkrj1vl20xY7sRw&oh=00_AfJk-e5Fr2wgCw0wtPmp51otT9r_vQAdP8ZWeMdlFmqVGA&oe=6840F6D1',

'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500619228_1910167373073016_2121919389437015394_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=fhvu-84yXWMQ7kNvwHh7d2a&_nc_oc=AdlqHdMTFXHfIr29zq9oz7s63GeHdF8fr6OM6IWFmLPUwN8Y5HyHR55kXgbMKDa2xoo&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=5OJJIKY9g8bhdWH72jPMhA&oh=00_AfLU2VmgnZERLcbGGHeeYDiaxpz9Og_C1hhUfPkj4p-g1A&oe=6840DAC1',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500974765_1356730738882231_841787111556849530_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=K_N9loMj3L4Q7kNvwGAIRdN&_nc_oc=AdmloQwatSTUBhqgWuZ9ajZTuNpD7otiUiCQ_OzdAVQhHwIHpKOqzq2dzdupKn9VHv0&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=5OJJIKY9g8bhdWH72jPMhA&oh=00_AfK5PHrSb_0c56qtKToaU-yI8kRDNsahENmbPd_jzj51Vw&oe=6840F449',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/497576123_710893974830097_3770164972956168082_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rVzbS0pwAKAQ7kNvwFQE8uh&_nc_oc=AdmBZ-6TCom1ALyLo0aB5XT-bIeCo0lc1ZxKZ6bvA2iIsh9xFg9nEOBTv3Z7LzYhRjw&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=5OJJIKY9g8bhdWH72jPMhA&oh=00_AfKHoaRkvfKqy-9Ic9SQOZmJg9TeHOYcbYzVQeI_IdnX6g&oe=6840EBDC',
];

/**
 * Fonction principale d'exécution
 */
async function main() {
  try {
    console.log('🖼️ === TÉLÉCHARGEUR D\'IMAGES FACEBOOK ===\n');
    
    if (FACEBOOK_IMAGE_URLS.length === 0) {
      console.log('⚠️ Aucune URL d\'image à traiter.');
      console.log('💡 Ajoutez vos URLs dans le tableau FACEBOOK_IMAGE_URLS');
      return;
    }
    
    // Exécution du traitement
    const results = await processFacebookImages(FACEBOOK_IMAGE_URLS);
    
    // Sauvegarde des résultats
    await saveResults(results);
    
    // Affichage des détails
    console.log('\n📋 DÉTAILS DES TÉLÉCHARGEMENTS:');
    results.results.forEach(result => {
      console.log(`\n${result.success ? '✅' : '❌'} Image ${result.index}:`);
      if (result.success) {
        console.log(`   📁 Fichier: ${path.basename(result.filename)}`);
        console.log(`   💾 Taille: ${(result.fileSize / 1024).toFixed(1)} KB`);
        console.log(`   🎨 Format: ${result.format}`);
        if (result.dimensions) {
          console.log(`   📐 Dimensions: ${result.dimensions.width}x${result.dimensions.height}`);
        }
      } else {
        console.log(`   ❌ Erreur: ${result.error}`);
      }
      console.log(`   ⏱️ Durée: ${Math.round(result.duration / 1000)}s`);
    });
    
  } catch (error) {
    console.error('💥 Erreur dans main():', error);
    process.exit(1);
  }
}

// Exportation pour utilisation modulaire
module.exports = {
  processFacebookImages,
  saveResults,
  CONFIG
};

// Exécution si le script est lancé directement
if (require.main === module) {
  main();
}