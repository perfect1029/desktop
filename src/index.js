const rgb = (r, g, b, msg) => `\x1b[38;2;${r};${g};${b}m${msg}\x1b[0m`;
global.log = (...args) => console.log(`[${rgb(88, 101, 242, 'Gluon')}]`, ...args);

process.versions.gluon = '5.1-dev';

import { join, dirname, delimiter, sep } from 'path';
import { access, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';

import Chromium from './browser/chromium.js';
import Firefox from './browser/firefox.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const browserPaths = ({
  win32: process.platform === 'win32' && {
    chrome: join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    chrome_canary: join(process.env.LOCALAPPDATA, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
    edge: join(process.env['PROGRAMFILES(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),

    firefox: join(process.env.PROGRAMFILES, 'Mozilla Firefox', 'firefox.exe'),
    firefox_nightly: join(process.env.PROGRAMFILES, 'Firefox Nightly', 'firefox.exe'),
  },

  linux: { // these should be in path so just use the name of the binary
    chromium: 'chromium',
    firefox: 'firefox',
  }
})[process.platform];

let _binariesInPath; // cache as to avoid excessive reads
const getBinariesInPath = async () => {
  if (_binariesInPath) return _binariesInPath;

  return _binariesInPath = (await Promise.all(process.env.PATH
    .replaceAll('"', '')
    .split(delimiter)
    .filter(Boolean)
    .map(x => readdir(x.replace(/"+/g, '')).catch(() => [])))).flat();
};

const exists = async path => {
  if (path.includes(sep)) return await access(path).then(() => true).catch(() => false);

  // just binary name, so check path
  return (await getBinariesInPath()).some(x => x.includes(path));
};

const findBrowserPath = async (forceBrowser) => {
  if (forceBrowser) return [ browserPaths[forceBrowser], forceBrowser ];

  let whichBrowser = '';

  for (const x of Object.keys(browserPaths)) {
    if (process.argv.includes('--' + x) || process.argv.includes('--' + x.split('_')[0])) {
      whichBrowser = x;
      break;
    }
  }

  if (!whichBrowser) {
    for (const x in browserPaths) {
      log('checking if ' + x + ' exists:', browserPaths[x], await exists(browserPaths[x]));

      if (await exists(browserPaths[x])) {
        whichBrowser = x;
        break;
      }
    }
  }

  if (!whichBrowser) return null;

  return [ browserPaths[whichBrowser], whichBrowser ];
};

const getFriendlyName = whichBrowser => whichBrowser[0].toUpperCase() + whichBrowser.slice(1).replace(/[a-z]_[a-z]/g, _ => _[0] + ' ' + _[2].toUpperCase());
const getDataPath = () => join(__dirname, '..', 'chrome_data');

const startBrowser = async (url, { windowSize, forceBrowser }) => {
  const dataPath = getDataPath();

  const [ browserPath, browserName ] = await findBrowserPath(forceBrowser);

  const browserFriendlyName = getFriendlyName(browserName);

  log('browser path:', browserPath);
  log('data path:', dataPath);

  if (!browserPath) return log('failed to find a good browser install');

  const browserType = browserName.startsWith('firefox') ? 'firefox' : 'chromium';

  return await (browserType === 'firefox' ? Firefox : Chromium)({
    browserName: browserFriendlyName,
    dataPath,
    browserPath
  }, {
    url,
    windowSize
  });
};

export const open = async (url, { windowSize, onLoad, forceBrowser } = {}) => {
  log('starting browser...');

  const Browser = await startBrowser(url, { windowSize, forceBrowser });

  if (onLoad) {
    const toRun = `(() => {
      if (window.self !== window.top) return; // inside frame

      (${onLoad.toString()})();
    })();`;

    Browser.window.eval(toRun);

    await Browser.cdp.send(`Page.enable`);
    await Browser.cdp.send(`Page.addScriptToEvaluateOnNewDocument`, {
      source: toRun
    });
  }

  return Browser;
};