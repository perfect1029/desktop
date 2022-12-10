const rgb = (r, g, b, msg) => `\x1b[38;2;${r};${g};${b}m${msg}\x1b[0m`;
const log = (...args) => console.log(`[${rgb(88, 101, 242, 'Gluon')}]`, ...args);

process.versions.gluon = '3.1';

const presets = { // Presets from OpenAsar
  'base': '--autoplay-policy=no-user-gesture-required --disable-features=WinRetrieveSuggestionsOnlyOnDemand,HardwareMediaKeyHandling,MediaSessionService', // Base Discord
  'perf': '--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist --enable-hardware-overlays=single-fullscreen,single-on-top,underlay --enable-features=EnableDrDc,CanvasOopRasterization,BackForwardCache:TimeToLiveInBackForwardCacheInSeconds/300/should_ignore_blocklists/true/enable_same_site/true,ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes,UseSkiaRenderer,WebAssemblyLazyCompilation --disable-features=Vulkan --force_high_performance_gpu', // Performance
  'battery': '--enable-features=TurnOffStreamingMediaCachingOnBattery --force_low_power_gpu', // Known to have better battery life for Chromium?
  'memory': '--in-process-gpu --js-flags="--lite-mode --optimize_for_size --wasm_opt --wasm_lazy_compilation --wasm_lazy_validation --always_compact" --renderer-process-limit=2 --enable-features=QuickIntensiveWakeUpThrottlingAfterLoading' // Less (?) memory usage
};

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { access } from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const chromiumPathsWin = {
  stable: join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  canary: join(process.env.LOCALAPPDATA, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
  edge: join(process.env['PROGRAMFILES(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  // todo: add more common good paths/browsers here
};

const exists = path => access(path).then(() => true).catch(() => false);

const findChromiumPath = async () => {
  let whichChromium = '';

  for (const x of [ 'stable', 'canary', 'edge' ]) {
    if (process.argv.includes('--' + x)) whichChromium = x;
  }

  if (!whichChromium) {
    for (const x in chromiumPathsWin) {
      log('checking if ' + x + ' exists:', chromiumPathsWin[x], await exists(chromiumPathsWin[x]));

      if (await exists(chromiumPathsWin[x])) {
        whichChromium = x;
        break;
      }
    }
  }

  if (!whichChromium) return null;

  return chromiumPathsWin[whichChromium];
};

const getDataPath = () => join(__dirname, '..', 'chrome_data');

const startChromium = async (url, { windowSize }) => {
  const dataPath = getDataPath();
  const chromiumPath = await findChromiumPath();

  log('chromium path:', chromiumPath);
  log('data path:', dataPath);

  if (!chromiumPath) return log('failed to find a good chromium install');

  const proc = spawn(chromiumPath, [
    `--app=${url}`,
    `--remote-debugging-pipe`,
    `--user-data-dir=${dataPath}`,
    windowSize ? `--window-size=${windowSize.join(',')}` : '',
    ...`--new-window --disable-extensions --disable-default-apps --disable-breakpad --disable-crashpad --disable-background-networking --disable-domain-reliability --disable-component-update --disable-sync --disable-features=AutofillServerCommunication ${presets.perf}`.split(' ')
  ].filter(x => x), {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
  });

  proc.stdout.pipe(proc.stdout);
  proc.stderr.pipe(proc.stderr);

  // todo: move this to it's own library
  const { 3: pipeWrite, 4: pipeRead } = proc.stdio;

  let onReply = {};
  const onMessage = msg => {
    msg = JSON.parse(msg);

    log('received', msg);
    if (onReply[msg.id]) {
      onReply[msg.id](msg);
      delete onReply[msg.id];
    }

    if (msg.method === 'Runtime.bindingCalled' && msg.name === 'gluonSend') onWindowMessage(JSON.parse(msg.payload));
  };

  let msgId = 0;
  const sendMessage = async (method, params = {}, sessionId = undefined) => {
    const id = msgId++;

    const msg = {
      id,
      method,
      params
    };

    if (sessionId) msg.sessionId = sessionId;

    pipeWrite.write(JSON.stringify(msg));
    pipeWrite.write('\0');

    log('sent', msg);

    const reply = await new Promise(res => {
      onReply[id] = msg => res(msg);
    });

    return reply.result;
  };

  let pending = '';
  pipeRead.on('data', buf => {
    let end = buf.indexOf('\0'); // messages are null separated

    if (end === -1) { // no complete message yet
      pending += buf.toString();
      return;
    }

    let start = 0;
    while (end !== -1) { // while we have pending complete messages, dispatch them
      const message = pending + buf.toString(undefined, start, end); // get next whole message
      onMessage(message);

      start = end + 1; // find next ending
      end = buf.indexOf('\0', start);
      pending = '';
    }

    pending = buf.toString(undefined, start); // update pending with current pending
  });

  pipeRead.on('close', () => log('pipe read closed'));

  // await new Promise(res => setTimeout(res, 1000));

  const target = (await sendMessage('Target.getTargets')).targetInfos[0];

  const { sessionId } = await sendMessage('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true
  });

  (await sendMessage('Runtime.enable', {}, sessionId)); // enable runtime API

  (await sendMessage('Runtime.addBinding', { // setup sending from window to Node via Binding
    name: '_gluonSend'
  }, sessionId));

  const evalInWindow = async func => {
    return await sendMessage(`Runtime.evaluate`, {
      expression: typeof func === 'string' ? func : `(${func.toString()})()`
    }, sessionId);
  };

  evalInWindow(`(() => {
let onIPCReply = {};
window.Gluon = {
  versions: {
    gluon: '${process.versions.gluon}',
    builder: '${'GLUGUN_VERSION' === 'G\LUGUN_VERSION' ? 'nothing' : 'Glugun GLUGUN_VERSION'}',
    node: '${process.versions.node}',
    chromium: navigator.userAgentData.brands.find(x => x.brand === "Chromium").version,

    v8: {
      node: '${process.versions.v8}'
    }
  },

  send: async (type, data, id = undefined) => {
    id = id ?? Math.random().toString().split('.')[1];

    window._gluonSend(JSON.stringify({
      id,
      type,
      data
    }));

    if (id) return;

    const reply = await new Promise(res => {
      onIPCReply[id] = msg => res(msg);
    });

    return reply;
  },

  _recieve: msg => {
    const { id, type, data } = msg;

    if (onIPCReply[id]) {
      onIPCReply[id]({ type, data });
      delete onIPCReply[id];
      return;
    }

    if (window.Gluon.recieve?.(type, data) !== true) {
      window.Gluon.send('pong', {}, id);
    }
  },

  _send: window._gluonSend
};

delete window._gluonSend;
})();`); // inject nice reciever and sender wrappers

  let onIPCReply = {};
  const sendToWindow = async (type, data, id = undefined) => {
    id = id ?? Math.random().toString().split('.')[1];

    evalInWindow(`window.Gluon._recieve(${JSON.stringify({
      id,
      type,
      data
    })})`);

    if (id) return; // we are replying, don't expect reply back

    const reply = await new Promise(res => {
      onIPCReply[id] = msg => res(msg);
    });

    return reply;
  };

  const onWindowMessage = ({ id, type, data }) => {
    if (onIPCReply[id]) {
      onIPCReply[id]({ type, data });
      delete onIPCReply[id];
      return;
    }

    if (windowMessageCallback(type, data) !== true) { // true = replied itself, otherwise simply pong
      sendToWindow('pong', {}, id);
    }
  };

  let windowMessageCallback = () => {};

  return {
    window: {
      onMessage: cb => {
        windowMessageCallback = cb;
      },
      send: sendToWindow,

      eval: evalInWindow,
    },

    CDP: {
      send: (method, params) => sendMessage(method, params, sessionId)
    }
  };
};

export const open = async (url, onLoad = undefined, { windowSize } = {}) => {
  log('starting chromium...');

  const Chromium = await startChromium(url, { windowSize });

  if (onLoad) {
    const toRun = `(() => {
      if (window.self !== window.top) return; // inside frame

      (${onLoad.toString()})();
    })();`;

    Chromium.window.eval(toRun);

    await Chromium.CDP.send(`Page.enable`);
    await Chromium.CDP.send(`Page.addScriptToEvaluateOnNewDocument`, {
      source: toRun
    });
  }


  return Chromium;
};
