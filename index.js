const axios = require('axios');
const cheerio = require('cheerio');
const core = require('@actions/core');

const version = process.argv[2]; // Получение версии OpenWRT из аргумента командной строки
const filterTargetsStr = process.argv[3] || ''; // Фильтр по targets (опционально, через запятую)
const filterSubtargetsStr = process.argv[4] || ''; // Фильтр по subtargets (опционально, через запятую)

// Преобразуем строки с запятыми в массивы
const filterTargets = filterTargetsStr ? filterTargetsStr.split(',').map(t => t.trim()).filter(t => t) : [];
const filterSubtargets = filterSubtargetsStr ? filterSubtargetsStr.split(',').map(s => s.trim()).filter(s => s) : [];

if (!version) {
  core.setFailed('Version argument is required');
  process.exit(1);
}

const url = `https://downloads.openwrt.org/releases/${version}/targets/`;

async function fetchHTML(url) {
  try {
    const { data } = await axios.get(url);
    return cheerio.load(data);
  } catch (error) {
    console.error(`Error fetching HTML for ${url}: ${error}`);
    throw error;
  }
}

async function getTargets() {
  const $ = await fetchHTML(url);
  const targets = [];
  $('table tr td.n a').each((index, element) => {
    const name = $(element).attr('href');
    if (name && name.endsWith('/')) {
      targets.push(name.slice(0, -1));
    }
  });
  return targets;
}

async function getSubtargets(target) {
  const $ = await fetchHTML(`${url}${target}/`);
  const subtargets = [];
  $('table tr td.n a').each((index, element) => {
    const name = $(element).attr('href');
    if (name && name.endsWith('/')) {
      subtargets.push(name.slice(0, -1));
    }
  });
  return subtargets;
}

async function getDetails(target, subtarget) {
  const packagesUrl = `${url}${target}/${subtarget}/packages/`;
  const $ = await fetchHTML(packagesUrl);
  let vermagic = '';
  let pkgarch = '';

  // 1. Пытаемся найти pkgarch в тексте страницы (OpenWrt обычно пишет "Packages for architecture: ...")
  const pageText = $('body').text();
  const archMatch = pageText.match(/Packages for architecture:\s+([a-zA-Z0-9_-]+)/i);
  if (archMatch) {
    pkgarch = archMatch[1];
  }

  $('a').each((index, element) => {
    const name = $(element).attr('href');
    
    // 2. Ищем файл ядра (теперь он начинается на kernel-)
    if (name && name.startsWith('kernel-')) {
      // Обновленный Regex для новых версий (хеш после тильды)
      const vermagicMatch = name.match(/kernel-.*?~([a-f0-9]+)(?:-r\d+)?(?:_|-)?(.*?)\.apk$/);
      
      if (vermagicMatch) {
        vermagic = vermagicMatch[1];
        // Если pkgarch не нашли выше, пробуем взять остаток из имени файла (если он там есть)
        if (!pkgarch && vermagicMatch[2]) {
          pkgarch = vermagicMatch[2];
        }
      }
    }
  });

  // 3. если всё еще пусто, берем pkgarch из ссылки на базовый репозиторий
  if (!pkgarch) {
    try {
      // Ищем ссылку на основной репозиторий пакетов, которая всегда содержит архитектуру
      const baseRepoLink = $('a').filter((i, el) => $(el).text().includes('base')).first().attr('href');
      if (baseRepoLink) {
        // Ссылка обычно вида ../../../packages/aarch64_cortex-a53/base
        const parts = baseRepoLink.split('/');
        const archIndex = parts.indexOf('packages');
        if (archIndex !== -1 && parts[archIndex + 1]) {
          pkgarch = parts[archIndex + 1];
        }
      }
    } catch (e) {
      console.error("Failed to fallback arch detection");
    }
  }

  return { vermagic, pkgarch };
}

async function main() {
  try {
    const targets = await getTargets();
    const jobConfig = [];

    for (const target of targets) {
      // Пропускаем target, если указан массив фильтров и target не входит в него
      if (filterTargets.length > 0 && !filterTargets.includes(target)) {
        continue;
      }

      const subtargets = await getSubtargets(target);
      for (const subtarget of subtargets) {
        // Пропускаем subtarget, если указан массив фильтров и subtarget не входит в него
        if (filterSubtargets.length > 0 && !filterSubtargets.includes(subtarget)) {
          continue;
        }

        // Добавляем в конфигурацию только если:
        // 1. Оба массива пустые (автоматическая сборка по тегу) - собираем всё
        // 2. Оба массива НЕ пустые (ручной запуск) - target И subtarget должны быть в своих массивах
        const isAutomatic = filterTargets.length === 0 && filterSubtargets.length === 0;
        const isManualMatch = filterTargets.length > 0 && filterSubtargets.length > 0 &&
                              filterTargets.includes(target) && filterSubtargets.includes(subtarget);
        
        if (!isAutomatic && !isManualMatch) {
          continue;
        }

        const { vermagic, pkgarch } = await getDetails(target, subtarget);

        jobConfig.push({
          tag: version,
          target,
          subtarget,
          vermagic,
          pkgarch,
        });
      }
    }

    core.setOutput('job-config', JSON.stringify(jobConfig));
  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
