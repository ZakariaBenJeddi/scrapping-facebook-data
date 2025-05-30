const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

// ============= CONFIGURATION =============
const CONFIG = {
  // Sélecteur CSS pour les éléments créatifs
  CREATIVE_SELECTOR: '.creative',
  
  // Nombre d'URLs à traiter en parallèle
  BATCH_SIZE: 5,
  
  // Timeout pour le chargement des pages (en ms)
  PAGE_TIMEOUT: 30000,
  
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
 * Extrait les URLs src des éléments créatifs d'une page
 * @param {string} url - URL de la page à analyser
 * @param {puppeteer.Browser} browser - Instance du navigateur
 * @returns {Promise<Object>} Résultat avec l'URL et les src extraites
 */
async function extractCreativeSrc(url, browser) {
  const page = await browser.newPage();
  
  try {
    console.log(`🔄 Traitement de: ${url}`);
    
    // Configuration de la page
    await page.setDefaultTimeout(CONFIG.PAGE_TIMEOUT);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigation vers la page
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: CONFIG.PAGE_TIMEOUT 
    });
    
    // Attendre un peu plus pour s'assurer que les éléments dynamiques sont chargés
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Extraire les URLs src des éléments créatifs
    const creativeSrcs = await page.evaluate((selector) => {
      const elements = document.querySelectorAll(selector);
      const srcs = [];
      
      elements.forEach(element => {
        // Récupérer src de l'élément lui-même s'il en a un
        if (element.src) {
          srcs.push(element.src);
        }
        
        // Récupérer src des éléments enfants (img, video, etc.)
        const childElements = element.querySelectorAll('[src]');
        childElements.forEach(child => {
          if (child.src) {
            srcs.push(child.src);
          }
        });
      });
      
      // Supprimer les doublons
      return [...new Set(srcs)];
    }, CONFIG.CREATIVE_SELECTOR);
    
    console.log(`✅ ${creativeSrcs.length} URLs extraites de: ${url}`);
    
    return {
      url: url,
      success: true,
      creativeSrcs: creativeSrcs,
      count: creativeSrcs.length,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`❌ Erreur pour ${url}:`, error.message);
    
    return {
      url: url,
      success: false,
      error: error.message,
      creativeSrcs: [],
      count: 0,
      timestamp: new Date().toISOString()
    };
    
  } finally {
    await page.close();
  }
}

/**
 * Traite un lot d'URLs en parallèle
 * @param {string[]} urlBatch - Lot d'URLs à traiter
 * @param {puppeteer.Browser} browser - Instance du navigateur
 * @returns {Promise<Object[]>} Résultats du lot
 */
async function processBatch(urlBatch, browser) {
  const promises = urlBatch.map(url => extractCreativeSrc(url, browser));
  return Promise.all(promises);
}

/**
 * Fonction principale
 * @param {string[]} urls - Tableau des URLs à traiter
 * @returns {Promise<Object>} Résultats complets
 */
async function scrapeCreativeUrls(urls) {
  console.log(`🚀 Démarrage du scraping de ${urls.length} URLs`);
  console.log(`📊 Configuration: ${CONFIG.BATCH_SIZE} URLs en parallèle`);
  console.log(`🎯 Sélecteur: ${CONFIG.CREATIVE_SELECTOR}`);
  
  let browser;
  const results = [];
  const startTime = Date.now();
  
  try {
    // Lancement du navigateur
    console.log('🌐 Lancement du navigateur...');
    browser = await puppeteer.launch(CONFIG.BROWSER_OPTIONS);
    
    // Traitement par lots
    for (let i = 0; i < urls.length; i += CONFIG.BATCH_SIZE) {
      const batch = urls.slice(i, i + CONFIG.BATCH_SIZE);
      const batchNumber = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(urls.length / CONFIG.BATCH_SIZE);
      
      console.log(`\n📦 Traitement du lot ${batchNumber}/${totalBatches} (${batch.length} URLs)`);
      
      const batchResults = await processBatch(batch, browser);
      results.push(...batchResults);
      
      // Pause entre les lots pour éviter la surcharge
      if (i + CONFIG.BATCH_SIZE < urls.length) {
        console.log('⏸️ Pause de 2 secondes...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
  } catch (error) {
    console.error('💥 Erreur critique:', error);
    throw error;
    
  } finally {
    // Fermeture du navigateur
    if (browser) {
      console.log('🔒 Fermeture du navigateur...');
      await browser.close();
    }
  }
  
  const endTime = Date.now();
  const duration = Math.round((endTime - startTime) / 1000);
  
  // Statistiques
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalCreatives = results.reduce((sum, r) => sum + r.count, 0);
  
  console.log('\n📈 RÉSULTATS:');
  console.log(`✅ Succès: ${successful}/${urls.length}`);
  console.log(`❌ Échecs: ${failed}/${urls.length}`);
  console.log(`🎨 Total créatives trouvées: ${totalCreatives}`);
  console.log(`⏱️ Durée: ${duration}s`);
  
  return {
    summary: {
      totalUrls: urls.length,
      successful,
      failed,
      totalCreatives,
      duration: `${duration}s`,
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
  const defaultFilename = `creative_scraping_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filepath = path.join(process.cwd(), filename || defaultFilename);
  
  try {
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`💾 Résultats sauvegardés: ${filepath}`);
  } catch (error) {
    console.error('❌ Erreur lors de la sauvegarde:', error);
  }
}

// ============= EXEMPLE D'UTILISATION =============

// URLs d'exemple (remplacez par vos URLs réelles)
const EXAMPLE_URLS = [
  // 'https://scontent.frak1-1.fna.fbcdn.net/v/t42.1790-2/488573191_1351136402769184_7297854576896494413_n.mp4?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=Ozw8GuyNDGMQ7kNvwGyLq69&_nc_oc=AdkflZYwETTe_miHWyywpp4B9UOaV4Bf01nFoDTOhkI2vi1a4Gvl79W8mYZOgiykhOw&_nc_zt=28&_nc_ht=scontent.frak1-1.fna&_nc_gid=nlERBMxB7NZvHVK2Pk6RWg&oh=00_AfKc91rWeIVy_SbwO9zpe0XOcVQC9unQfJ76vKHKIW9-ew&oe=683A8FAE',
  // 'https://scontent.frak2-2.fna.fbcdn.net/v/t42.1790-2/501124220_1192680748835521_8267595088741959971_n.mp4?_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=ti1KErpMZpIQ7kNvwHjJ15o&_nc_oc=AdlVFByEiW34V-cUbJ8zbXbXhDFj8sdZHcstDdWx14RmTjLhGrIecE1jydxjnYrPISY&_nc_zt=28&_nc_ht=scontent.frak2-2.fna&_nc_gid=qYR_264VLtvdKgukUdESZQ&oh=00_AfJD6-tyv8D_gk_0cQRV7_8NLIHng52_BgA_81PLr867hA&oe=683A7675',
  // 'https://scontent.frak1-1.fna.fbcdn.net/v/t42.1790-2/500757129_1807787799798087_362855798395075270_n.mp4?_nc_cat=101&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=6qnWoPmoHykQ7kNvwHgFuhD&_nc_oc=AdmUVb14_DQUo7jEpyFEZwYFW5D-JlARKr1KPm5BnQONE_3EvWFj_7fLVa8qxzAJr7I&_nc_zt=28&_nc_ht=scontent.frak1-1.fna&_nc_gid=qYR_264VLtvdKgukUdESZQ&oh=00_AfJ3JrIimsoHIRKJhjo4kPn58IjR_nYZLqRQg4UXuio_qQ&oe=683AA0D4',
  // 'https://scontent.frak2-2.fna.fbcdn.net/v/t42.1790-2/500577572_1016342600588696_4832500291348496172_n.mp4?_nc_cat=107&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=a-hWeDzFSLgQ7kNvwEWjoTi&_nc_oc=Adn8cgXfn69UtIIkDd4Q0AGsMDpAQIRwf2y5lwACKkbmjp_MINbsePV8JB8j61uMZqs&_nc_zt=28&_nc_ht=scontent.frak2-2.fna&_nc_gid=qYR_264VLtvdKgukUdESZQ&oh=00_AfLOlSIEtUZAOX-lqRcF6RQfLNHNb7Q2Qj-GSnaFB9nyVQ&oe=683A87D9',
  // 'https://scontent.frak1-2.fna.fbcdn.net/v/t42.1790-2/501098356_692715217023056_507005849011468251_n.mp4?_nc_cat=111&ccb=1-7&_nc_sid=c53f8f&_nc_ohc=soE_m_w7NSEQ7kNvwE8YhJF&_nc_oc=AdnZNxp5jieosORzQjHP8CZhxVWo8prMMXbW0BdxOprtFeuCLh1GVRGwciDvTkNh9P4&_nc_zt=28&_nc_ht=scontent.frak1-2.fna&_nc_gid=qYR_264VLtvdKgukUdESZQ&oh=00_AfLZddQ9tg3aR7T6qG5v9vJHMTRDzAW_Zbn-0madT7Ibyw&oe=683A7DB0',
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&q=KHALIJEMARKET.MYECOMSITE.NET&search_type=keyword_unordered',
  'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&is_targeted_country=false&media_type=all&q=alarabyshop.myecomsite.net&search_type=keyword_unordered',
];

/**
 * Fonction principale d'exécution
 */
async function main() {
  try {
    // 📝 CONFIGURATION: Modifiez ces URLs avec les vôtres
    const urlsToScrape = EXAMPLE_URLS;
    
    if (urlsToScrape.length === 0) {
      console.log('⚠️ Aucune URL à traiter. Modifiez la variable EXAMPLE_URLS.');
      return;
    }
    
    // Exécution du scraping
    const results = await scrapeCreativeUrls(urlsToScrape);
    
    // Sauvegarde des résultats
    await saveResults(results);
    
    // Affichage d'un échantillon des résultats
    console.log('\n🔍 ÉCHANTILLON DES RÉSULTATS:');
    results.results.slice(0, 3).forEach(result => {
      console.log(`\n${result.success ? '✅' : '❌'} ${result.url}`);
      if (result.success && result.creativeSrcs.length > 0) {
        result.creativeSrcs.slice(0, 2).forEach(src => {
          console.log(`  🎨 ${src}`);
        });
        if (result.creativeSrcs.length > 2) {
          console.log(`  ... et ${result.creativeSrcs.length - 2} autres`);
        }
      }
    });
    
  } catch (error) {
    console.error('💥 Erreur dans main():', error);
    process.exit(1);
  }
}

// ============= FONCTIONS UTILITAIRES =============

/**
 * Parse les URLs depuis une chaîne (ex: copié depuis Google Sheets)
 * @param {string} text - Texte contenant les URLs
 * @returns {string[]} Tableau d'URLs
 */
function parseUrlsFromText(text) {
  const urlRegex = /https?:\/\/[^\s\n\r]+/g;
  return text.match(urlRegex) || [];
}

/**
 * Charge les URLs depuis un fichier texte
 * @param {string} filepath - Chemin vers le fichier
 * @returns {Promise<string[]>} URLs
 */
async function loadUrlsFromFile(filepath) {
  try {
    const content = await fs.readFile(filepath, 'utf8');
    return parseUrlsFromText(content);
  } catch (error) {
    console.error('❌ Erreur lecture fichier:', error);
    return [];
  }
}

// Exportation des fonctions pour utilisation modulaire
module.exports = {
  scrapeCreativeUrls,
  saveResults,
  parseUrlsFromText,
  loadUrlsFromFile,
  CONFIG
};

// Exécution si le script est lancé directement
if (require.main === module) {
  main();
}