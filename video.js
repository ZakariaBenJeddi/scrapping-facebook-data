const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const https = require('https');
const path = require('path');

// ============= CONFIGURATION =============
const CONFIG = {
  // Nombre d'URLs à traiter en parallèle
  BATCH_SIZE: 3,
  
  // Timeout pour les téléchargements (en ms)
  DOWNLOAD_TIMEOUT: 60000,
  
  // Dossier de téléchargement
  DOWNLOAD_FOLDER: './downloads',
  
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
 * Télécharge un fichier depuis une URL
 * @param {string} url - URL du fichier à télécharger
 * @param {string} filename - Nom du fichier de destination
 * @returns {Promise<Object>} Résultat du téléchargement
 */
async function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout de téléchargement'));
    }, CONFIG.DOWNLOAD_TIMEOUT);

    const file = require('fs').createWriteStream(filename);
    
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timeout);
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const progress = Math.round((downloadedSize / totalSize) * 100);
          process.stdout.write(`\r📥 ${filename}: ${progress}%`);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        clearTimeout(timeout);
        file.close();
        console.log(`\n✅ Téléchargé: ${filename}`);
        resolve({
          success: true,
          filename: filename,
          size: downloadedSize,
          url: url
        });
      });

      file.on('error', (err) => {
        clearTimeout(timeout);
        file.close();
        require('fs').unlink(filename, () => {}); // Supprimer le fichier partiel
        reject(err);
      });

    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Vérifie si une URL est encore valide (non expirée)
 * @param {string} url - URL à vérifier
 * @returns {Promise<boolean>} True si l'URL est valide
 */
async function checkUrlValidity(url) {
  return new Promise((resolve) => {
    https.get(url, { method: 'HEAD' }, (response) => {
      resolve(response.statusCode === 200);
    }).on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Traite une URL Facebook (vérification + téléchargement)
 * @param {string} url - URL Facebook à traiter
 * @param {number} index - Index de l'URL dans la liste
 * @returns {Promise<Object>} Résultat du traitement
 */
async function processFacebookUrl(url, index) {
  const startTime = Date.now();
  
  try {
    console.log(`\n🔄 Traitement ${index + 1}: ${url.substring(0, 80)}...`);
    
    // Vérifier si l'URL est encore valide
    console.log('🔍 Vérification de la validité...');
    const isValid = await checkUrlValidity(url);
    
    if (!isValid) {
      return {
        url: url,
        index: index + 1,
        success: false,
        error: 'URL expirée ou inaccessible',
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
    }
    
    // Créer le nom de fichier
    const urlObj = new URL(url);
    const videoId = urlObj.pathname.split('/').pop().split('.')[0];
    const extension = url.includes('.mp4') ? '.mp4' : '.video';
    const filename = path.join(CONFIG.DOWNLOAD_FOLDER, `facebook_video_${index + 1}_${videoId}${extension}`);
    
    // Télécharger le fichier
    console.log('📥 Début du téléchargement...');
    const downloadResult = await downloadFile(url, filename);
    
    return {
      url: url,
      index: index + 1,
      success: true,
      filename: downloadResult.filename,
      fileSize: downloadResult.size,
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
 * Traite un lot d'URLs en parallèle
 * @param {string[]} urlBatch - Lot d'URLs à traiter
 * @param {number} batchStartIndex - Index de début du lot
 * @returns {Promise<Object[]>} Résultats du lot
 */
async function processBatch(urlBatch, batchStartIndex) {
  const promises = urlBatch.map((url, i) => 
    processFacebookUrl(url, batchStartIndex + i)
  );
  return Promise.all(promises);
}

/**
 * Fonction principale de traitement des URLs Facebook
 * @param {string[]} urls - Tableau des URLs Facebook à traiter
 * @returns {Promise<Object>} Résultats complets
 */
async function processFacebookUrls(urls) {
  console.log(`🚀 Démarrage du traitement de ${urls.length} URLs Facebook`);
  console.log(`📊 Configuration: ${CONFIG.BATCH_SIZE} URLs en parallèle`);
  console.log(`📁 Dossier de téléchargement: ${CONFIG.DOWNLOAD_FOLDER}`);
  
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
      
      console.log(`\n📦 === LOT ${batchNumber}/${totalBatches} (${batch.length} URLs) ===`);
      
      const batchResults = await processBatch(batch, i);
      results.push(...batchResults);
      
      // Pause entre les lots
      if (i + CONFIG.BATCH_SIZE < urls.length) {
        console.log('\n⏸️ Pause de 3 secondes entre les lots...');
        await new Promise(resolve => setTimeout(resolve, 3000));
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
  
  console.log('\n' + '='.repeat(50));
  console.log('📈 RÉSULTATS FINAUX:');
  console.log(`✅ Téléchargements réussis: ${successful}/${urls.length}`);
  console.log(`❌ Échecs: ${failed}/${urls.length}`);
  console.log(`💾 Taille totale téléchargée: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`⏱️ Durée totale: ${duration}s`);
  console.log('='.repeat(50));
  
  return {
    summary: {
      totalUrls: urls.length,
      successful,
      failed,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      duration: `${duration}s`,
      downloadFolder: CONFIG.DOWNLOAD_FOLDER,
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
  const defaultFilename = `facebook_download_results_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filepath = path.join(process.cwd(), filename || defaultFilename);
  
  try {
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 Résultats sauvegardés: ${filepath}`);
  } catch (error) {
    console.error('❌ Erreur lors de la sauvegarde:', error);
  }
}

// ============= VOS URLs FACEBOOK =============
const FACEBOOK_URLS = [
  
];

/**
 * Fonction principale d'exécution
 */
async function main() {
  try {
    console.log('🎬 === TÉLÉCHARGEUR VIDÉOS FACEBOOK ===\n');
    
    if (FACEBOOK_URLS.length === 0) {
      console.log('⚠️ Aucune URL à traiter.');
      return;
    }
    
    // Exécution du traitement
    const results = await processFacebookUrls(FACEBOOK_URLS);
    
    // Sauvegarde des résultats
    await saveResults(results);
    
    // Affichage des détails
    console.log('\n📋 DÉTAILS DES TÉLÉCHARGEMENTS:');
    results.results.forEach(result => {
      console.log(`\n${result.success ? '✅' : '❌'} URL ${result.index}:`);
      if (result.success) {
        console.log(`   📁 Fichier: ${path.basename(result.filename)}`);
        console.log(`   💾 Taille: ${(result.fileSize / 1024 / 1024).toFixed(2)} MB`);
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
  processFacebookUrls,
  saveResults,
  CONFIG
};

// Exécution si le script est lancé directement
if (require.main === module) {
  main();
}