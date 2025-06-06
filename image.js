const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const https = require('https');
const path = require('path');

// ============= CONFIGURATION =============
const today = new Date().toISOString().split('T')[0]; 
const CONFIG = {
  // Nombre d'URLs à traiter en parallèle
  BATCH_SIZE: 5,
  
  // Timeout pour les téléchargements (en ms)
  DOWNLOAD_TIMEOUT: 30000,
  
  // Dossier de téléchargement
  // DOWNLOAD_FOLDER: './images',
  DOWNLOAD_FOLDER: path.join(__dirname, 'images', today),
  
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
  







'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/492062538_1024383465785817_7356995924878267563_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QDUPHWnOJEMQ7kNvwFYLlCx&_nc_oc=Adn63n9MMtwlZU4J6LyRAMzbr02SY227zTERWCSevzL20fqiBW3ilKE5XZvMVcnh0C8&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=o9bXU1ZeIgTa6NUDOxrLVg&oh=00_AfIZLgz5rp33rrCixp8i00ho2Mi00eQd8KSJPdPNf6cgew&oe=68426153',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/491941444_1181886476469548_2929995418683985698_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=109&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=jA5BstOlMSAQ7kNvwGOY8My&_nc_oc=AdkZDQDVVwZOZotZy0QPRMrdva8i0jephxsN3wzibRmymYl0-YqrdXSKsad5K3XmvN4&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=o9bXU1ZeIgTa6NUDOxrLVg&oh=00_AfLOCAhqixJPnlt9JrRL8oDpVaF2p7lGK6cf4A8-cBqh7w&oe=68425433',




'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500619228_1910167373073016_2121919389437015394_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=zEkkhHYChpMQ7kNvwGXla0g&_nc_oc=AdkwpAfKT-ErntVvcwch2Hkj9EGz8KCNfeR5iPFNBcR5yuQPOXuSXfCOL3gWs-XUpqw&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=o9bXU1ZeIgTa6NUDOxrLVg&oh=00_AfK7peVMMXNHz6cSAvomhvP_Xj3BV0wBpwBGCqu2S9UvQQ&oe=68426481',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500979556_23881592568102666_4455591527709106564_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=hC5fI0B2dvYQ7kNvwHJfvtf&_nc_oc=AdnCi6nmN54jdAhM2ykkVIP0tf8rtsUfu2O7sqwRZle1Vz_7Nt_Pz8ZsBFAijMTtDPU&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=o9bXU1ZeIgTa6NUDOxrLVg&oh=00_AfK3qOEZrxhQ7JLtNLTbrpiMvWr6bK5HYEw_8ZaNGM6clQ&oe=684247F1',

'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500974765_1356730738882231_841787111556849530_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=nFGIKDaRB5sQ7kNvwGdoyPQ&_nc_oc=AdnZI5YD7yTuEwfyvVpxg5GxLCAB-FhUuuJFRGnnevzd9GJzpBQH1QEadmAmcCFQ8kk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=o9bXU1ZeIgTa6NUDOxrLVg&oh=00_AfJLYDFlbXYd0SRplTJTSI1GJ4eHCcJ0mRDTvOTbOPvxcw&oe=684245C9',






'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499891915_674168815484090_3009841361971983757_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QQPzIx0-CpoQ7kNvwHntDP_&_nc_oc=Adn2oBCcA4WDQJt03VNDqNRfAs4Js-q3GnS7O0cYLOjDMFN5aPpa6N_LZ4vAn1YwSlc&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfJ9gLHbnsgV8jSrtQ7X2Uj2crM1Q7o_XqgGvAOCfjkBYw&oe=684247F7',

'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500224853_1066057678745757_2832744651772679210_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=p17-yR_-o4sQ7kNvwGtuREP&_nc_oc=Admto0HN-7fPkFnFs9XIW5BRFYfUTpErEsmbU2EjTvSRduq5MI2dUjM9euNYOHS1UlY&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfKgr1W9DFCs22AWOQWNdfNUWMl7WgsKl5-Nm_hocb0nKA&oe=68424AF6',


'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/499933223_1098230652231037_5690618053007233840_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=8YhzvpqecKsQ7kNvwHQsQ_z&_nc_oc=AdkfHooPjNcB-bhoaoGQJjC4rDuUlYg3CFs49J1Lwv4OPpgH33Dy7cCT2SV2SAaUw3o&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfLj7lK84ie1j_sD6Dp43LOYjMVWOEKb2l-2RvPf_rv-_w&oe=684272DF',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/499722224_1125353939474543_6534314210933797504_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=HnQGf8gBiskQ7kNvwFaSIqD&_nc_oc=AdleABaXitNorzfr0OX8s44G-iRWi4qmEx8zZ17GV4v7n83TdWu8swvb22nB0Oz03DU&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfJ7d6U9zuNqXnw9DADZKsQaF69irr_F7YcjfNH6-WIzqw&oe=6842533F',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499576229_1018713517075575_5499035728123300505_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=mTwoBPbwP8sQ7kNvwHWzDfP&_nc_oc=AdnmX-9qTnMt6OJK8TBKAasmQcE-TUHikLkssKkcSxC6itH_Pn83vHrWSPyOd-ou7DM&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfKBmmYMIszD_QzSYr6eLF4FDtPUY8dxigFmbIhH3lMGEg&oe=6842431E',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499847744_579140668109247_8433202669265494343_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=wxBYizDhseMQ7kNvwHEYk7y&_nc_oc=AdnE2Nb1LMarnOaQrNj9hMqoaBg8C3_ojM-7Z51MdNCJqmE8Lgq4vUPEMGCFgtnohlQ&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfILb-PuWQaqbEPbEBz5dW_Kp1UsZW5BTDq13B8KxacRng&oe=68425F4F',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/499786380_3921410988110200_1490134657068279760_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=a2jwktvsKxQQ7kNvwFXY1_W&_nc_oc=AdlDpMCeDrLJBMF2if48fvjdSolT_AiIPEpR_VW38RdQMfRifPv7ROYV3FCYjd6uo6E&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfJ1F6lOfkTeBLDLpPGhK6LAsyhuFue5ao8L3Rn9UnBTSA&oe=68426842',


'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/497576123_710893974830097_3770164972956168082_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rVzbS0pwAKAQ7kNvwGR2VFx&_nc_oc=Admop0Qd7jSxHgEsySP9FT0_UIewBg_h4Upph2AMnq0z2xdxmTzkExIyzZC2ioEMloU&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=pkhkfIlamXY2atYOs15EVA&oh=00_AfJ2rKmf2IvjvLDE2r7pttycFyck36f0540elS8jPh7qxQ&oe=6842759C',








'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/478146596_1325730261911873_6176457404653182218_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=QxuD69AhNbQQ7kNvwGeScsd&_nc_oc=Adlz9yEfADjkEHxUy7g7d8V0Qk2_YTuaHxhFbeQtCJbQsWLmfbB-YhTdl4VEjnuFsfk&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=ceQ8CuI71X9IggGAH7r-eg&oh=00_AfI4LNqI30V-rXR2aqm324uUhdjJQPSpcR3dhZlzUFYZjg&oe=6842673F',


'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473713120_9012961305448147_873647950264734092_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Hdt_Fy6V2mIQ7kNvwGUE0sq&_nc_oc=AdljaRAIvEOD-rngRdlFHJv136mWGXog1gb24UVRMA0YFk2Bg7f81ho47GB4d2pONPs&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=ceQ8CuI71X9IggGAH7r-eg&oh=00_AfIURzewYGCaC2e7mhiLy902dAtrDuEp4dCHh-2fR4A8xg&oe=6842536D',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/473221248_1605551616758330_8070596323176819918_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=AMYKlGUN4Y8Q7kNvwHGIdQO&_nc_oc=Adk9vg_5ilkccyxlmAxWsPFTwsUKQ0qYrYuNmePlqXLpNrVMhddsUl_yKLc1FLfni2E&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=ceQ8CuI71X9IggGAH7r-eg&oh=00_AfI3YHqh2LNxHxJj5_V1WjIBp2NYevwMS2tZwzum-OuLmA&oe=68424491',














'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/502584728_1641325143237098_2122371844940918900_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=102&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ql2arisye7wQ7kNvwFjo-W5&_nc_oc=AdnrzmNmr7lzFSHxooymyesfF-XEkcSuzChEqqoh7Led8EnDMrq4yPE7FKmMu82jsbM&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfKbnqYR1HE3uPMH8IpyNWBZb-cnrvR9kLq4EFp0MTi0mQ&oe=68424158',




'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/502518658_1695793804385256_4718972883364433419_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=R1HBRxn550wQ7kNvwG3-PzZ&_nc_oc=AdkKG-yKAgf0N_-OSHc9PD0ODHFNtcPBUuYnQr3E67cokQqrfWRemCACKWpRWF8V87k&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfKKOjPJZeEh7KK8LoSkmpm-mOsxpKLbOqqpaBOcD0J24Q&oe=6842667E',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500126229_1390495012259892_1247311902617128423_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=L59Sb_epqhMQ7kNvwHnuN_l&_nc_oc=AdkoozHEBGJYBQN-h5ji_--lnYd0qsWYoQkx4qaBChIfA5i2C9cMsYqKh_OvfeetIGk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfKv0nhJM7a9RO35kTZEf2AhMg1PcLxpfyCrYXjPonY1YA&oe=6842609A',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/501039331_2212192375946478_3826197938590926462_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=xyZsG9FwdMQQ7kNvwGycul0&_nc_oc=AdmJuM_cYA07o8pOsD2L5RItvU-fCwBrt2BWGUDhw55F6YSP86Q-jlrxDjXQvnZ3klY&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfLSkQmnyYOdeWsD0_dbLN4FaQ9WiiLLpcxnabAbM2m1ew&oe=684276DB',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/499482843_544736308710033_7201633913811951013_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=n292xKnO2EUQ7kNvwErEF43&_nc_oc=AdmjRgg5VGzH8_uo0Do7bKnEEqSBJRfRq-IMhktgOyo0nff1hEu-ITRsZ_3f5zsHfh4&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfLT6rdUbe4LcDiGNJiNljC_BB8yyqowkwA58UsFdp8WDA&oe=684276C3',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/495776621_1195559932250842_7092363957854391034_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=1x1GRyO8c78Q7kNvwFdTMIE&_nc_oc=AdlLd11R09B36LkgePCLYXsVqUJ-HPp0-tMKZAw7aSmHTB_XDdr2kHC3ywwu3IMIpSw&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfLyE28guIE4eZI44i8t2-X0KZQHJqJ9_4ivwnEzW8TM1g&oe=68427056',


'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/486778887_1297347564663930_7658458553959912708_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=qzXvECOcLiwQ7kNvwHcEtIs&_nc_oc=AdlPzVdHRIFDDBE_lCRF27Tyu7eDsgXBpOtwV43WlAGYtia6vQUrAYqtgJnV9TU0XMA&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfIv49g9BVtOILSASSlmxFq0NUwrqNZwCdIxTAIKrvoYOQ&oe=68426EC0',
'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/486647312_1367435258015159_6335917901326750316_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=PpV2Ex07LggQ7kNvwGN8kfd&_nc_oc=Adka_Nvmjzu31ny8ot81r-0RsfDuFdjcGCL_kf1jgVMk9Zqzc_aZsry3WlffaYnLoEA&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=2eu1L55sQmOV19dphJFQnQ&oh=00_AfLhEJVUNqbIoBmLG0dC8yHNMGIhrxUVnfemD3pqVFPmIw&oe=68425A6D',

'https://scontent.frak2-2.fna.fbcdn.net/v/t39.35426-6/500103204_1193915162473582_4731556016032107937_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=104&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Wp2iYz9vTJUQ7kNvwEy6PIV&_nc_oc=AdkpCyi0Uk7OJWtzFbM4Q2euNd3Ju6Pa9gDegrgO7nWGX6OEOsEjQO0MGyGA4EUVSKE&_nc_zt=14&_nc_ht=scontent.frak2-2.fna&_nc_gid=i-ELJicl9-hvvaswrzlM7w&oh=00_AfLSSwilCNmnLW2AZ3zSdX16C12_IQc5Uk3jwB8RIlsCPQ&oe=68424603',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500472777_668774546125105_6878003791159888650_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=0fHkSL-1ehkQ7kNvwFxR6RY&_nc_oc=AdnZ1E3pkfu_65vaMPve-BVEAr358UFXtH4Nn-lOGg3P3HYsCL1O2QXgoZ6DRfDksR8&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=i-ELJicl9-hvvaswrzlM7w&oh=00_AfIu5Fe_fIqyJ9p72JtZxbyGrb-BkBt5sCak_Vt3CS2j5Q&oe=68425FEA',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/496926337_1247178983683439_7934725120214772989_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=_HSHjGVqAP0Q7kNvwEPoj2O&_nc_oc=AdkZIqWRQY36I61Y5cVwhY7A_mxr6IYcYaTJ4DfoGql1DWLOcad5d2GO3EB8DSlF3ic&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=i-ELJicl9-hvvaswrzlM7w&oh=00_AfIejY-bGxXtk89pEcIQaM2gtRxJU-r6_JqrFqA-57bgUw&oe=68425BC5',


'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/491189249_1298989654496125_2024122113216544301_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=kRTbL0mB7-0Q7kNvwHU0mWb&_nc_oc=AdlAAD0paJxY8AQk0hl226LL_35qsakYCvtA4CjRK1dMDx92h4kPLvNmV4PTijUSBrI&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=i-ELJicl9-hvvaswrzlM7w&oh=00_AfJJaDKKJJGCTNVLNlF8fcF8o2_wOIPYYQCyaSeF8IDBbA&oe=68424851',





'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/493303917_1813760235866863_2382908766612928274_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=KB5QYMsFs3AQ7kNvwE1Coes&_nc_oc=AdlMCnSBtiPfRgShblDXIV2GMWD3sK4Q8zvLy3327PSQ9z-y1Jd28MrshifGjoGG-q8&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=oZW8P-_ntV4T81T8TNFlaA&oh=00_AfJgWslYXaKPOa1jRgzrtEdj_TUfz4CUtRTogfTyKmvz_Q&oe=68425362',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/484919748_532380819880425_2886869660284142583_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=B8ziocNhYkQQ7kNvwFFwfoD&_nc_oc=Adm5RUn0zRMJ5305xp18dXSPSdhwTAxdZ-0EDBmXWsZtaXu-rpfLV70hV2wQ4zaWgac&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=oZW8P-_ntV4T81T8TNFlaA&oh=00_AfKpGfhYKRZx7PjxWyHNTFzQguCqnInyrBDalj-WUxuL2A&oe=684263FD',
'https://scontent.frak1-2.fna.fbcdn.net/v/t39.35426-6/502718895_706647081950347_1253787146016838871_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=100&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=3thvL_6l3AgQ7kNvwFjMZ1L&_nc_oc=AdnjlVN8m8M4FOQBoBaVEkayRyGtbgQDsoDfZd0zI1isUZ4vc5UXLeAG8alAm5tH9EQ&_nc_zt=14&_nc_ht=scontent.frak1-2.fna&_nc_gid=ZlVAvqtRSBoQ0U_idjF71g&oh=00_AfKeCzAkvcGpX-BWO_S-6xzRNBwqec9wgYRemwOeu8dItg&oe=684264FF',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/502648958_1240802124083923_8928396058076903243_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=DxGjFo7i1UIQ7kNvwHc-ObP&_nc_oc=Adm5YS000nxQ7Fyfb0q1w9NZQLQ8UH9_0NWactguKI9ueR3fl_mpXBRWercIFPT8q30&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=ZlVAvqtRSBoQ0U_idjF71g&oh=00_AfKBvSI80ly3rbF7ZoZGvKOqTiClm2CpznD6xMRrW1zmgw&oe=684242EB',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/497576123_710893974830097_3770164972956168082_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rVzbS0pwAKAQ7kNvwGR2VFx&_nc_oc=Admop0Qd7jSxHgEsySP9FT0_UIewBg_h4Upph2AMnq0z2xdxmTzkExIyzZC2ioEMloU&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=FLvqccVcR4VKl-JvHQcsAg&oh=00_AfI_Urq0kTUJZAqKxNuNHJzre7akgoeZtK8B1nXXeM3WFw&oe=6842759C',

'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500979556_23881592568102666_4455591527709106564_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=hC5fI0B2dvYQ7kNvwHJfvtf&_nc_oc=AdnCi6nmN54jdAhM2ykkVIP0tf8rtsUfu2O7sqwRZle1Vz_7Nt_Pz8ZsBFAijMTtDPU&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=TcktKQ5qpbMo3MyPtxLCEg&oh=00_AfJh4FE8mUWYlGtN4e29793qrI0n2Rxf8n20QW6V0rTxNw&oe=684247F1',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500126229_1390495012259892_1247311902617128423_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=110&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=L59Sb_epqhMQ7kNvwHnuN_l&_nc_oc=AdkoozHEBGJYBQN-h5ji_--lnYd0qsWYoQkx4qaBChIfA5i2C9cMsYqKh_OvfeetIGk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=TcktKQ5qpbMo3MyPtxLCEg&oh=00_AfL1h465IOD0gfJJdxocsj7SzzbolVOIKOB5pRGTLphaVQ&oe=6842609A',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/491189249_1298989654496125_2024122113216544301_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=103&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=kRTbL0mB7-0Q7kNvwHU0mWb&_nc_oc=AdlAAD0paJxY8AQk0hl226LL_35qsakYCvtA4CjRK1dMDx92h4kPLvNmV4PTijUSBrI&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=TcktKQ5qpbMo3MyPtxLCEg&oh=00_AfJ8GhkUIsnYyVyxCvF25fokjw9qK4eGS_-NI2uQxKV5lg&oe=68424851',

'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/500619228_1910167373073016_2121919389437015394_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=108&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=zEkkhHYChpMQ7kNvwGXla0g&_nc_oc=AdkwpAfKT-ErntVvcwch2Hkj9EGz8KCNfeR5iPFNBcR5yuQPOXuSXfCOL3gWs-XUpqw&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=NNx0xlYtJZL4_6T3GPTJDg&oh=00_AfIanfyT2DAmL7qtax9WWeQrT032ay9NQL_qsJUK8rLKvg&oe=68426481',
'https://scontent.frak2-1.fna.fbcdn.net/v/t39.35426-6/500974765_1356730738882231_841787111556849530_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=106&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=nFGIKDaRB5sQ7kNvwGdoyPQ&_nc_oc=AdnZI5YD7yTuEwfyvVpxg5GxLCAB-FhUuuJFRGnnevzd9GJzpBQH1QEadmAmcCFQ8kk&_nc_zt=14&_nc_ht=scontent.frak2-1.fna&_nc_gid=NNx0xlYtJZL4_6T3GPTJDg&oh=00_AfIt8kNW2xkffQRHnrmRcNvQz78RXEPAC_rwVPTArOkqFA&oe=684245C9',
'https://scontent.frak1-1.fna.fbcdn.net/v/t39.35426-6/497576123_710893974830097_3770164972956168082_n.jpg?stp=dst-jpg_s600x600_tt6&_nc_cat=105&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=rVzbS0pwAKAQ7kNvwGR2VFx&_nc_oc=Admop0Qd7jSxHgEsySP9FT0_UIewBg_h4Upph2AMnq0z2xdxmTzkExIyzZC2ioEMloU&_nc_zt=14&_nc_ht=scontent.frak1-1.fna&_nc_gid=NNx0xlYtJZL4_6T3GPTJDg&oh=00_AfIKSjquWhrEVr8w5BTbKpV2rApzMXHlkeCM5hHj9K0rrg&oe=6842759C',
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