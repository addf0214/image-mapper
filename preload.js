const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, value) {
  const response = await ipcRenderer.invoke(channel, value);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

contextBridge.exposeInMainWorld('imageMapper', {
  selectPhotos: () => invoke('select-photos'),
  selectGpx: () => invoke('select-gpx'),
  mapConfig: () => invoke('map-config'),
  searchPlace: query => invoke('search-place', query),
  runBatch: options => invoke('run-batch', options),
  onProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('batch-progress', listener);
    return () => ipcRenderer.removeListener('batch-progress', listener);
  }
});
