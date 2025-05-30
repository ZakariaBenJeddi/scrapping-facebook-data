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
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501755190_1684184652204826_8549469187854246192_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rxBu3SDgIvkQ7kNvwFbSQAE&_nc_oc=AdnGicIh-M9OcxfmFSWfvpb9Rbod-2Cf-wRV8xbVR-l7UGYe6lZGLDRDTfFv2ozKn-8&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfLyUe8Y7kbv9czsbHSaAzpLMlSduNmLpylSKpBQD-yc3w&oe=683FC97E',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500619228_1910167373073016_2121919389437015394_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=fhvu-84yXWMQ7kNvwEWiX79&_nc_oc=AdngRcj4k0kawrZMRpYitelm8Nd61L9UGzhLciT2js3wEU7a73NXNxXh1n5kRlHo7O0&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfKYj7qPd0jcyz5Z4pLL9QIwZe1xUtMV4OwuLfbdZc4KIQ&oe=683FC181',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500979556_23881592568102666_4455591527709106564_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=hC5fI0B2dvYQ7kNvwGr-GZp&_nc_oc=AdmZIlMgGd5hKv3w7VOM6Ntzn-40U1uPEZeJ7IHEYTR7WNX-wRdkEbRN6do1OYgwPRU&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfJW5IMrieQcTqiOezXMIyrMj4zeCDx4ZN2bnVmY0pQ7og&oe=683FA4F1',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500974765_1356730738882231_841787111556849530_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=K_N9loMj3L4Q7kNvwFTCJzT&_nc_oc=AdmyZUCORarZsuRIXecvwVmLoytBdJB6eFydm1ozQzh5j2pBuf2qZWn2jVQjB1pEC_o&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfLnDjWcoijaxHxSIW4GZKqcLV2rpPwNbMgeoOo_lpELYg&oe=683FDB09',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/500707153_1032940745100961_8958791648679235508_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=i83-KfsNwQAQ7kNvwExLf5r&_nc_oc=AdmJWcTNuWyq0n4uSKRoxhp-l0zJoxGof4ebOie17NVJ3ZxHFkzxwhpBPjH70Trbh8Q&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfI-ol-FuwZ3Ofbju7sLkK_L0uzjwyV-DTGDxXHkfYZnVA&oe=683FAAC2',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/495570444_1696668627614459_8973018943107125342_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=SyU3R0uGRHwQ7kNvwHRRyhM&_nc_oc=AdkroSJpQRbJFxMgDrMZu07DkySqApjYPIPoasMWM7oxXIQnYTg9KZG8woG0lFmZF48&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfInDld8xmunJZqgBoxjf03bwT7I2ozar2MkVmAnzLGgwg&oe=683FD2D2',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499891915_674168815484090_3009841361971983757_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=VZk-0LsAfmEQ7kNvwFtZEgO&_nc_oc=AdlnTqaKXX0oQheRffuvb5Yph8uYcvtlBBuWQ0oiYce7EW0LVbBEQVZuAyCy2tlFnjo&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfJ4wZiW_SYZ1XIlSAmnOVtJ1q1w8BJWF5hrvagSpnmPMg&oe=683FA4F7',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/500229744_1143723301103255_9192260014929946362_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=95P7aJ4-q-4Q7kNvwHAzacg&_nc_oc=AdnmCsVyponfXSaQ2EgXhxm6SPz3XD9OqCx73-KFCbTF2bJCNDBIFpOL-nTnPmQdimc&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfLw8bERddPUV48axoKI4NxSpZgn9Q83GG7N8KRuYK_Zzg&oe=683FDA88',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499154641_1761585948124128_2936941840741610118_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=13OWolcXwVAQ7kNvwFRnyRD&_nc_oc=AdlQ0XhTWECaPO_9Ux5KgEPXKDmlGj9Mie3pe5tXjzn7zy1sZZyUgl2dfhJYJAVsYDY&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=v4KMHmXBAc-9B4B0M_YTOA&oh=00_AfLtYxrk-wIzNcGOJVU64chOn8KsX8hGXyNSuuFXpNeXPw&oe=683FABCE',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/478146596_1325730261911873_6176457404653182218_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QxuD69AhNbQQ7kNvwFZbb-K&_nc_oc=AdmNb375abHJp6-mrjOsv8YcYg7vatiabyJAOhXJWK_ELW_K7JuumRJCt2iXkAQQBU0&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfKKaC72OH25P-CEN2DmaA-uNX2oRujvRRI5w4qiaK-yMg&oe=683FC43F',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/480743510_444889798613950_3694355446490392446_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=DPkHx-hi3NEQ7kNvwFRUGm8&_nc_oc=AdkDlSx-fP066qzuzh_0DLE_q_WgH-BKMuwP7Z_WVzZBVg-fP6yixmmcah72jAx-tOw&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfJ5egEy1tmyB-hIJB5lUf9Iz2Q5t2IXJMQ03Cb6Naso-Q&oe=683FCC2F',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/480568110_4038103693088482_1885838208142639315_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=BzgN-O6IHmUQ7kNvwEf5OXd&_nc_oc=AdlMxBBeOK8saFPb67obLefKWfaz88XCS2znzaKnVQQWI6dk1rGYFDJdNFzdLJGKpNQ&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfI0ac7fQQNSvjL4AKjUmXRxC1nO6tGdGMwHDjISRF5yhA&oe=683FD731',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/481287327_1979541965907353_7935778321140147086_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=bJN2GxBBtRgQ7kNvwEj5rZJ&_nc_oc=Adme5c3wJQtZN3_U73OkFJi8TxhG0yp4HHKeWlX77myeQvUbM-COnnQpaLI6nD33_Qk&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfLc7CX7KLglwABqek-d9Nps8pT7w14yHWAxY8PCJQwcsw&oe=683FC809',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/480497441_1822465631942669_429170805625080483_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=epdH65hm-0cQ7kNvwF8xkeY&_nc_oc=AdnSFEZVmjt2XqGbsIE9xMYfnAyG7vhoOHuWX_vla7RtV9DxzR9oTI4CPqAliDGb0b0&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfKBQS96eZIHGKjmgPPt6tltOm8515hA15s8CY-P9r7Trg&oe=683FD4E9',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/481132732_1783179925795665_4607229948051179918_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=5xPFmHS-NAkQ7kNvwENdxos&_nc_oc=AdmuuWuc8MIbOZjq1aUvjfA7-BmcCluowgEAkX8h40TVF2PCj3SaGCkholVWGmiCsUk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfL5RKwZG12g1bOJijI1s332uyBfYmuC4eu5jpb3VlfhSg&oe=683FABA9',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/480815153_884083697045648_405691276165951405_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=HugjLDorXD4Q7kNvwHNNSPK&_nc_oc=Adl3RnVWUGE5V5SQl_Ai4e4Jipua4izXgVSfFY2jjoyCIsDkBzqHmqQKbE3QPtetTT0&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfKcKRqgJmk8ZZ8bvT80gmI0e5s2wA6WMAffWCv8DecK6g&oe=683FCC34',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/480572200_1698721604373889_7160521275865304842_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=8i-AeA3imDwQ7kNvwGpC7MF&_nc_oc=AdksHMWB7D7BoFx9pJqCNqJHZRpx6iV3UiMnOvnms5oH2u6cDfndSGixmyXNfS2Nwqk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfKw_ICnyNVTOcVXY_yqQugD0vBtDuXBPwWQGD77NB90wA&oe=683FC588',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/480687069_1422945815513690_2336414063735235598_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=He8eMabY6foQ7kNvwE0T_BX&_nc_oc=AdnlRqzAde4MAve1peUD8uQkS8LoPZ95JKCbuh2IsSJcjwZC7hhrS13HiUTUgnrbviI&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfJ82psNI_OrQkawYbxeS2u-24sab3OwRor_0fiGDKGqXg&oe=683FBF74',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/481121397_1185358686533057_8707095590437915434_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=H60rM0hZx-UQ7kNvwE0bC0A&_nc_oc=Adnlthy2NPVOEl6Nk2qd_maXnLgHMub9M8brSPou8acFLFSvysFIvb9SHsS6vGbl1mk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfJwAokNyzHcxtBtn326g9mIwSC68KqeQaHZeOn04YjAKg&oe=683FC0E2',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/481229991_2099537940484824_8838942983919114644_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qk4MBtXvwpYQ7kNvwF8NS-B&_nc_oc=AdnzEgfXnHpApiuIU6vaKRjA2_N-uwWUc70UVyCAr5oCyX37XgUDBNe_qWReAV1qrjs&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfJKMWjkc7rHAdfGBLdPFP_TN8m8lmVsjoSUsXEJ8klyHQ&oe=683FBE15',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473388431_2050325515440149_4853798414183893674_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=tCgSmysNNH4Q7kNvwHtFXCQ&_nc_oc=AdmDklgQrYY_gaIpWE48FAgXidI7dEClg4mTzCc3_PFW8ymYzC1ftjNQFOR_XNwyxeE&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfKvVAZxX0W23tTmxnIvjm2KYDqKAg6V97Rx8D4j1Awpzg&oe=683FD893',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/481227217_512341528552592_9144644610262251716_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=oDC00IrLTR0Q7kNvwFkH8ZF&_nc_oc=AdkYhLqTYzmU35q6cHb-Hnb8MIqM8stx812hw09cVfrNNRQPqpoPzOWHD0XO8cFVy8Y&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=vicBw58HQfcVmZf1ycYEtw&oh=00_AfLB20bf9E_R1_G004XiJGmaTQiJP29vfNuWXbIPTV1Twg&oe=683FBDD9',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473713120_9012961305448147_873647950264734092_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=sx89ROhu11oQ7kNvwFUAWHq&_nc_oc=AdmCARB9J9aWK0Vez7bYhXYfgQ_yUj86XeCJhLl1n-JA4xSBhxaMgAwwxFq6Hf4FAR8&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=opQIVyxXNhLg-cATawSNrQ&oh=00_AfI3Jm7Axx9iKg4yVACoce5iBzfyIAcc_nY8NOBq8DRCnQ&oe=683FB06D',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473221248_1605551616758330_8070596323176819918_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=AMYKlGUN4Y8Q7kNvwGlNaZu&_nc_oc=Adl_gv26Zl3zpolJUiDVN43Zw19YeH54wjE2TlAhFDa92ZcVedvrwyHuf7zZ7JCYAMY&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=opQIVyxXNhLg-cATawSNrQ&oh=00_AfKyC3oisyG7_plp1MNjKcYg6LxrEzj_KvGuXSSMhIb3Lg&oe=683FD9D1',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/471207750_607307968456135_9005541230948313356_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=2RAlFMW3ZnAQ7kNvwHGHgoU&_nc_oc=AdnEcURM8rjePTxsgj-XP3PclyLJ_SDnEF9eYSSgZ9AWVPCcqdLCyer_JCzH0Ijqb9Q&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=opQIVyxXNhLg-cATawSNrQ&oh=00_AfKW-d4ENV-X8u1T0Ho2XUgP4siVjaR3Oz0GiDu3KSPNEg&oe=683FD8BC',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501026398_4199616646994507_6522803113684685872_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=pN9DPZ4tUNgQ7kNvwGZ68ol&_nc_oc=Adkmg9dv_AN4OiC0UtVs4cAl9DV-yBPwE5OuIEjbyevWQv8awOXtiha-pVd8MhbqM08&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfK4_V_zRC_2nd281FGu2nEx2yHMgKeFi3RN3KkQzmKugw&oe=683FB2D9',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/501296721_3108725019303400_6900677942422280247_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=vIV2Ev4ZajkQ7kNvwHwMZ8D&_nc_oc=AdlGNNxmcxJhJvu4_PBtY4Qt8XMSIH0RpYMnKwo2AtzmzMwtOcwanKc5jIpaXqLsGPQ&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfJ1zodbhg2rqPI8vI3vT1taLJRmV5Q697YDKc7NBWWrfA&oe=683FDD23',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/502518658_1695793804385256_4718972883364433419_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=AEH6QIukzZIQ7kNvwEL-ChO&_nc_oc=AdnLjyqXKAlV9NWkEzFtSk79zJk3Rh6pBOrNS4J1gUkdIPHuZdgkxyhnTaytIjz4nGs&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfLXlpgyQbmYvupENtJzEDHSMxBjyPlVOOHOmUElqFTLrQ&oe=683FC37E',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/500828709_681264211562246_8945342604373507211_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=eFFlvGn7fUYQ7kNvwGQIyrs&_nc_oc=Adm_Coz-mJ-IsZhASqv2qkw7g3oiB-jq0HCrSjwVDOD-ybKTdHzYde-VTGZ6lajNJpM&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfKaFqLYnJiyIC7e-AvS4O5Reophc1-175St-YZKd8c7hA&oe=683FD7DE',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500126229_1390495012259892_1247311902617128423_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=M9aM7Xkq-PwQ7kNvwHc1V8P&_nc_oc=AdmFumNaRN1sNds0DfLwYBR6nibUyT0OJpI8qN5d_ztl1YjGkiu7GwjsNtPOcNtrn-4&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfK7PaZiKtRwFyNpXyLQ9h7LYlqrTZ_LH9KBb8yRmYfp0g&oe=683FBD9A',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501267861_1195401338533948_5913742599826970550_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=GMdwCEu_lf4Q7kNvwGhg9J1&_nc_oc=AdmKKldqceBumrVjKOgHGeYc2KxPOwiFPztwKysMwHvkS6JvyDFVsTqjnE71p_dhRvs&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfKp4DPzCx0wdV2bgepn09gYSPMh_FRuQTXDUa-NbXR3YQ&oe=683FB903',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501039331_2212192375946478_3826197938590926462_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=jcqfWUs8PMAQ7kNvwEve6Zm&_nc_oc=AdnxRnH27QxcoKCLiVENMVw20jAXrUvT5iMjBnskwJ7-35n41o9og-W-KdZ5d8M2rhc&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfI-y--zIYjV3KcTrvgcoJtqHABNhqPVZBBDlzUeF0QN-w&oe=683FD3DB',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/499482843_544736308710033_7201633913811951013_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=YuGUnIMB0FgQ7kNvwHYzjO3&_nc_oc=Adn6wYTr8qIKiJtsF106AKnu86bJzcPV7Oq6eQt4iV_8qp0A5gCCkeMiGTmk5jOrZAE&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfLBLRP7BkiAMIVG-RqqHwxQdFpRfr_jwfG2Wo2Jk-zKdA&oe=683FD3C3',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/495776621_1195559932250842_7092363957854391034_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=jt-goyDTZmkQ7kNvwG0gUgx&_nc_oc=AdnMP2Iq3pMUcj2J6g6m5fLjloVSjXrRUVTEECBRA_dQMeJfbU_ptzlpyv7GccE_B0Q&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfKEVT9IncbAp7w3kqg8vW-6hZjAmjAa5wS5lRn_ZCMQEQ&oe=683FCD56',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/488706975_1048512720462107_4333760746791477841_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Tc07zpE_a58Q7kNvwFEo_fn&_nc_oc=AdldqjO34ZbaA9ZzDTiM3lNVStaGSczCqu-oSWkdG11fLQ1IIAJLbYR2sepvVixPeyc&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfK4PyDwacRP-HNgCsVFFmDiII0H0Kfgu163PAMdm6dIrQ&oe=683FB6EC',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/488932338_1183165329551675_6858074107523746671_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=DgrV9CmF45gQ7kNvwEIMkA3&_nc_oc=Adn9vfFCgvcT10SMUN17QOnUO-6dg-Da8zEWXPxR1-uEQ0XH4pr6cqhPUR0ljXEx8GI&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfIBCV8lfsOZP3334nWEv0jbPsRE-bWa6eFV7Gd3hgF0jQ&oe=683FD82F',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/488936726_629274259923104_1236779126774771513_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=9vguLcfdIO4Q7kNvwGl795f&_nc_oc=AdnPh_vj2dGu7jrjABS_9k0dxsbEC8sFQrjF70ivHhox1pAHHONQq78SCc0IanVJEVE&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfLCRTsvH6cMzEKsVVzkHVGNDysWRNw9cbE0OGfQmTUbrA&oe=683FBDF9',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/486778887_1297347564663930_7658458553959912708_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=2gCXats6uFQQ7kNvwFsHgLH&_nc_oc=AdnejRe64g70o-xxbWmXA1Aba_yIlWXuDIOdzoSr02-OIkeG8jw75WCCMh-PFP5PK9A&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfKjysNyBOgy4q8ejKEpR7w34WE4kVan16YGaMva1Bqt1g&oe=683FCBC0',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/486647312_1367435258015159_6335917901326750316_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=dgRvyDGUthwQ7kNvwE-8tMa&_nc_oc=Adl2uRs7o8izhsCbn_PrMTDPXEQaZcYg0VMKxy45pF8NSFuOn1kWTHP9oQLUQ57DQi8&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfL_M_KMyfMKv-gcxmcE2Z0y1k3vWsSfK58r5gazrBjVKQ&oe=683FB76D',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/482979020_1008168417865073_588913525482957112_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=-TOl09sx8V0Q7kNvwEkgmi_&_nc_oc=AdnGrnudVZIRFuLSRXS8jbGCd2t7d-ii44E_H16AMpXvP24xLwWrnFvP2ncTqA89bMo&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfIdRAcWruz8Ti0r0kEjxuiHNqbQeQLxrXIXQFH6NOtnNw&oe=683FC886',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/482316100_1644256142861927_4861822421307467253_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=jDKu5duFriQQ7kNvwHlJgrN&_nc_oc=AdmOOp-TeFqh6-mlgv9PJT2n32amnXbMh2gsPwCWW8BWDgrmYKcLPze2Ayh3MTaRWhs&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfIrSPqU9Z0f5XBJFmi_eHRQUjkDGlyNA5rmdqB4H6i1GA&oe=683FB5AD',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473388431_2050325515440149_4853798414183893674_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=tCgSmysNNH4Q7kNvwHtFXCQ&_nc_oc=AdmDklgQrYY_gaIpWE48FAgXidI7dEClg4mTzCc3_PFW8ymYzC1ftjNQFOR_XNwyxeE&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=YEWVb1ErOWR2rnMbLVlFWw&oh=00_AfI_IRIZSne2wVYpQr94L3xur9rPOmwumyW50hi5rXWMAg&oe=683FD893',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/474533111_636625855385314_5278582020379872331_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=pO4UvupsbboQ7kNvwGq1_km&_nc_oc=Adm2JKaF4_f-xb7uFcebcWtbdZVbozrCcbQ-lrOdK9pTK9zHLwAStJjvqZnienFuMiE&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=VUHKDgr1PQE5t3Zeq_iMRQ&oh=00_AfK4K5QIZ219-i1uTQ6rWbrkWpF_rs7Ph0Gbxa4UelD_ag&oe=683FDC9F',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/500103204_1193915162473582_4731556016032107937_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=o7oVHmWdCHAQ7kNvwHy7dO0&_nc_oc=Adn5y0EuB_pjVSl0n2arKoA44Uk2Eop3IR-5ODp0h8mZ_cbfv1eSYhmZz9h6dFm7sig&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfII-W1dbTK8UkyTTUSjIOVTvtLRdNESnV6KRLic87Rv1A&oe=683FDB43',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500472777_668774546125105_6878003791159888650_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=0fHkSL-1ehkQ7kNvwE-laoA&_nc_oc=AdmFHfpbrCIKrWkG7lk6QHHPCAItlqOc7ckrU0W4lO1ElYuJVHw3t4zj_2bAsIys-Xk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfLqiOfm7WHP5Fm2Qq2ZbKRuJ5or5DAyXCC2kssjhfT8jg&oe=683FBCEA',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/496926337_1247178983683439_7934725120214772989_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=x9QVGmD77kcQ7kNvwHDVFwQ&_nc_oc=AdkQtDx0XMfuEHcituRTTnAWQ2U-nINemtArY1-89iwU-3KrnHogNgjOSkow2Z9odfk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfKG211OL6GqKljHf5nj4fieussE5LwwQvW5mtZyJW9yrQ&oe=683FB8C5',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/489828834_2386496095049754_7758083600881165515_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=zOLJlX5K_QcQ7kNvwGooFTd&_nc_oc=AdmLBzlBDQaOGhGmie5PGmjSV1il4wOjHtNEAs_G2ervN_ETGWF8-Yc8zvraRSMMOQI&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfLlsL8eyPKFq9rjB7Hunw1bBAPunHHx_Mnn0XFTf7dcTw&oe=683FC9F8',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/489785028_1725966051683186_1188632210168857647_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=c2QZhF-zjDgQ7kNvwEk_zh8&_nc_oc=Admc3rXKwG8oFPe8bncg1QZJm7aszBGcvd9k6tKZ-Jz8wJElwDu86-SLosDs2fQl3YY&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfIYs1HBmzFYMFcgPdyTaUZf19IccUzmUOaL5bCTyxVoYw&oe=683FBE76',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/488943036_9336809256440578_1022673970543668574_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=mkl4aU75GC0Q7kNvwEEm1qB&_nc_oc=AdkwmP-4oNm16YKCbR4tx1Et9A2QZzoA1K4_eYGr6nidQw0B0WgsLKe5e_Q-5KHFYhc&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfJ3X8Ku5AiLRfO5GFOv3yEnbi3hGxaBoE9aOdxFp4mikQ&oe=683FC061',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/489625987_2417463508605299_670320484100622128_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=xSJExG4FtlAQ7kNvwEWC9bV&_nc_oc=AdnU4WwNMMgLvGFbWffg4_22GNQdtrYKYABcyXyuSYR-Bxlfkp3D0YRr4pTFUb35vL0&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfIO_5h9Tuu1aJrEDh_0jTZuAzqjgBXZiddLy6wkSMjqRw&oe=683FBAC4',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/488706975_1048512720462107_4333760746791477841_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Tc07zpE_a58Q7kNvwFEo_fn&_nc_oc=AdldqjO34ZbaA9ZzDTiM3lNVStaGSczCqu-oSWkdG11fLQ1IIAJLbYR2sepvVixPeyc&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfJFdEXVig0DsPZyB478shPxmgKPOgta5ji_3HDPdrKNSw&oe=683FB6EC',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/488932338_1183165329551675_6858074107523746671_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=DgrV9CmF45gQ7kNvwEIMkA3&_nc_oc=Adn9vfFCgvcT10SMUN17QOnUO-6dg-Da8zEWXPxR1-uEQ0XH4pr6cqhPUR0ljXEx8GI&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfLez45SpdvDIBuF-hsKEhrog1jOTeC5oWeekjxV5bTcIA&oe=683FD82F',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/488936726_629274259923104_1236779126774771513_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=9vguLcfdIO4Q7kNvwGl795f&_nc_oc=AdnPh_vj2dGu7jrjABS_9k0dxsbEC8sFQrjF70ivHhox1pAHHONQq78SCc0IanVJEVE&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfIGhCfEWXMm_wQgmcFrydf77q9nNDjp5Nokx3gwdL0_5w&oe=683FBDF9',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/491189249_1298989654496125_2024122113216544301_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=kRTbL0mB7-0Q7kNvwG8sHcR&_nc_oc=AdnJ6qE4iUIxq08m15KnEomRlRqP_VREL3kdVtryALXDxePTeIHkDENFfjABMZgO8AI&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfLO4OS7Go2c9N1aCnFXIBVgEYvBy174UIGL_GVL6DOpCQ&oe=683FDD91',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/482089616_1328891808429992_369363976451281872_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=gBQVtu6P7zUQ7kNvwFMW0E4&_nc_oc=Adk2-6gfpNdGYcSLAoavN3M2TmtVkNHVYmSnokejAQtK_VebWLhUBKtdHiul_K_k2O8&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfLNI28N5jROXilQ6aSew0vwjsD0nRY4zTSkb3dHZVJBxw&oe=683FCDC3',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473388431_2050325515440149_4853798414183893674_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=tCgSmysNNH4Q7kNvwHtFXCQ&_nc_oc=AdmDklgQrYY_gaIpWE48FAgXidI7dEClg4mTzCc3_PFW8ymYzC1ftjNQFOR_XNwyxeE&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=shY8YwjCFZ3u00GElfL5iQ&oh=00_AfIUfSjvNYhZK7D5pXiyGN0PCXP5a_ubZNiiF7qoGmQeBQ&oe=683FD893',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/482979020_1008168417865073_588913525482957112_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=-TOl09sx8V0Q7kNvwEkgmi_&_nc_oc=AdnGrnudVZIRFuLSRXS8jbGCd2t7d-ii44E_H16AMpXvP24xLwWrnFvP2ncTqA89bMo&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=ZFiWVfwWYcw1l5gulZ4uUg&oh=00_AfLcPw5iThGDqP75XdtRRI4hhTdUpfUwkQWWGbHF7nTAag&oe=683FC886',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/482316100_1644256142861927_4861822421307467253_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=jDKu5duFriQQ7kNvwHlJgrN&_nc_oc=AdmOOp-TeFqh6-mlgv9PJT2n32amnXbMh2gsPwCWW8BWDgrmYKcLPze2Ayh3MTaRWhs&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=ZFiWVfwWYcw1l5gulZ4uUg&oh=00_AfIl5FLJqFRUZh96Iu8zcMlNIgMdFAb99b1fpaxHD96l9g&oe=683FB5AD',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473388431_2050325515440149_4853798414183893674_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=tCgSmysNNH4Q7kNvwHtFXCQ&_nc_oc=AdmDklgQrYY_gaIpWE48FAgXidI7dEClg4mTzCc3_PFW8ymYzC1ftjNQFOR_XNwyxeE&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=ZFiWVfwWYcw1l5gulZ4uUg&oh=00_AfIOawdk2giSA2uf9LlwjYeAJ5_N3fglADTlzJck2PkEPg&oe=683FD893',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/474533111_636625855385314_5278582020379872331_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=pO4UvupsbboQ7kNvwGq1_km&_nc_oc=Adm2JKaF4_f-xb7uFcebcWtbdZVbozrCcbQ-lrOdK9pTK9zHLwAStJjvqZnienFuMiE&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=ZFiWVfwWYcw1l5gulZ4uUg&oh=00_AfL8fLUtvGf_7eiZj8acwsR4cYAMwE897oiyE8Lo8TyBqw&oe=683FDC9F',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/497576123_710893974830097_3770164972956168082_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rVzbS0pwAKAQ7kNvwGmgmK9&_nc_oc=Adk7o6cuNxmxCsGZVBUhfGQl0fe4FFc48REwWJsKttLTbDCxqvGN5J9Bt-kMw-pUSGY&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=QZCh9TYG95WD89nr0YMgNA&oh=00_AfKxKPrHSXh5F_1KQ2xAVQ8G2IgyIxBFZmqIkPQpsHNrYQ&oe=683FD29C',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/498395730_3999774323579299_6964304187605145798_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=7joJDendmioQ7kNvwEVYBqk&_nc_oc=AdlPSiVFS9czPopMPBtu_wtUmYeZMZwCCZJ1MGZtmPDQtKLZWaO_ikx-CPSrGCBuHNo&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=m5a4gAYxJpd7eS4z9TyiJQ&oh=00_AfKpCV5KClJvnMKJr2H8dP1_GmxcofSTfH7D4AOJBa9btg&oe=683FBE69',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/498605037_2126570481100502_5347064513823131088_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ZiT_2F02s0IQ7kNvwHm2MWI&_nc_oc=Adk5yNpjMSj4xrbKIoJB6o28thbsNV8AwMho-zOMyTqIocD_BSEXFYJ_CAJY7lcdwWg&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=m5a4gAYxJpd7eS4z9TyiJQ&oh=00_AfL-02KdBp51xZBAHZZ29iWv-b0STNtKYZMToCUvTdSDRA&oe=683FB093',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501026398_4199616646994507_6522803113684685872_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=pN9DPZ4tUNgQ7kNvwGZ68ol&_nc_oc=Adkmg9dv_AN4OiC0UtVs4cAl9DV-yBPwE5OuIEjbyevWQv8awOXtiha-pVd8MhbqM08&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=gILIVSbAXrSk-TmK38CdvA&oh=00_AfK3ahRDJRFuWOXYv17Wg05SqbXz9leKHaNZJSOhUE9iQg&oe=683FB2D9',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/501296721_3108725019303400_6900677942422280247_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=vIV2Ev4ZajkQ7kNvwHwMZ8D&_nc_oc=AdlGNNxmcxJhJvu4_PBtY4Qt8XMSIH0RpYMnKwo2AtzmzMwtOcwanKc5jIpaXqLsGPQ&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=gILIVSbAXrSk-TmK38CdvA&oh=00_AfLD1DzZMysp05sEAwU1r_8KBbNC1urPKwalUvm0FXJQbg&oe=683FDD23',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500979556_23881592568102666_4455591527709106564_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=hC5fI0B2dvYQ7kNvwGr-GZp&_nc_oc=AdmZIlMgGd5hKv3w7VOM6Ntzn-40U1uPEZeJ7IHEYTR7WNX-wRdkEbRN6do1OYgwPRU&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=gILIVSbAXrSk-TmK38CdvA&oh=00_AfL7vCIRpRdp7k4nw_MJTWP-wXYnXH-zqGFiGQ2esg19Bg&oe=683FDD31',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500126229_1390495012259892_1247311902617128423_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=M9aM7Xkq-PwQ7kNvwHc1V8P&_nc_oc=AdmFumNaRN1sNds0DfLwYBR6nibUyT0OJpI8qN5d_ztl1YjGkiu7GwjsNtPOcNtrn-4&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=gILIVSbAXrSk-TmK38CdvA&oh=00_AfJ_aJtcTvEtoGi2uEEQ-QQ3ELXlQYer8PPq2pKsDt8Meg&oe=683FBD9A',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/491189249_1298989654496125_2024122113216544301_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=kRTbL0mB7-0Q7kNvwG8sHcR&_nc_oc=AdnJ6qE4iUIxq08m15KnEomRlRqP_VREL3kdVtryALXDxePTeIHkDENFfjABMZgO8AI&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=gILIVSbAXrSk-TmK38CdvA&oh=00_AfJ7HrEyMZWtf1soC0UY_gqOaUh2UVt9ErLeWh09QDpd4Q&oe=683FDD91',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/471207750_607307968456135_9005541230948313356_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=2RAlFMW3ZnAQ7kNvwHGHgoU&_nc_oc=AdnEcURM8rjePTxsgj-XP3PclyLJ_SDnEF9eYSSgZ9AWVPCcqdLCyer_JCzH0Ijqb9Q&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=gILIVSbAXrSk-TmK38CdvA&oh=00_AfIrp5Hoz3IA6R6u_zFZFpqniOuo4ZbUEw2S8Qc0dFIXLQ&oe=683FD8BC',
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