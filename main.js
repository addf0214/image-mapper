const { app, BrowserWindow, dialog, ipcMain, net, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runBatch } = require('./metadata');
const { coordinates } = require('./location');

const pageUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const tileUrl = process.env.IMAGE_MAPPER_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const searchUrl = process.env.IMAGE_MAPPER_SEARCH_URL || 'https://nominatim.openstreetmap.org/search';
const userAgent = 'ImageMapper/1.0 (personal Windows photo geotagging)';
let window, photos = [], gpxPath = null, busy = false, searching = false, lastSearch = 0;
const searchCache = new Map();

function handle(name, action) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) {
      throw new Error('不允许的页面请求。');
    }
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

handle('select-photos', async () => {
  if (busy) throw new Error('正在处理照片，请等待完成。');
  const result = await dialog.showOpenDialog(window, {
    title: '选择要直接修改的照片', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Sony ARW / JPEG', extensions: ['arw', 'jpg', 'jpeg'] }]
  });
  if (!result.canceled) photos = [...new Set(result.filePaths)];
  return photos.map(file => path.basename(file));
});

handle('select-gpx', async () => {
  if (busy) throw new Error('正在处理照片，请等待完成。');
  const result = await dialog.showOpenDialog(window, {
    title: '选择 PixTrack GPX', properties: ['openFile'], filters: [{ name: 'GPX', extensions: ['gpx'] }]
  });
  if (!result.canceled) gpxPath = result.filePaths[0];
  return gpxPath ? path.basename(gpxPath) : null;
});

handle('map-config', () => ({ tileUrl }));

handle('search-place', async query => {
  if (typeof query !== 'string' || !query.trim()) throw new Error('请输入地点名称。');
  query = query.trim();
  if (query.length > 200) throw new Error('搜索内容过长。');
  if (searchCache.has(query)) return searchCache.get(query);
  if (searching || Date.now() - lastSearch < 1100) throw new Error('搜索过于频繁，请稍后再点击搜索。');
  searching = true;
  lastSearch = Date.now();
  try {
    const url = new URL(searchUrl);
    if (url.protocol !== 'https:') throw new Error('搜索服务必须使用 HTTPS。');
    url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5', 'accept-language': 'zh,en' }).toString();
    const response = await net.fetch(url.href, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('搜索服务返回格式无效。');
    const results = data.map(item => ({ ...coordinates(item.lat, item.lon), name: String(item.display_name) }));
    searchCache.set(query, results);
    return results;
  } catch (error) { throw new Error(`地点搜索失败：${error.message}`); }
  finally { searching = false; }
});

handle('run-batch', async options => {
  if (busy) throw new Error('已有任务正在执行。');
  busy = true;
  try {
    return await runBatch({ files: [...photos], gpxPath, mode: options.mode, zone: options.zone?.trim(), overwrite: Boolean(options.overwrite), position: options.position }, progress => {
      if (!window.isDestroyed()) window.webContents.send('batch-progress', progress);
    });
  } finally { busy = false; }
});

app.whenReady().then(() => {
  // Chromium's persistent HTTP cache honors tile Cache-Control / Expires.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
    details.requestHeaders['User-Agent'] = userAgent;
    callback({ requestHeaders: details.requestHeaders });
  });
  window = new BrowserWindow({
    width: 1060, height: 850, minWidth: 820, minHeight: 650,
    title: 'Image Mapper', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://www.openstreetmap.org/') || url.startsWith('https://operations.osmfoundation.org/')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (busy) {
      event.preventDefault();
      dialog.showMessageBox(window, { type: 'info', message: '照片仍在写入，请在本批完成后关闭窗口。' });
    }
  });
  window.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
