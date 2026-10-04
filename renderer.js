const api = window.imageMapper;
const $ = id => document.getElementById(id);
let map, marker, position = null, mapDisabled = false, processing = false;
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const names = { success: '成功', skipped: '跳过', failed: '失败' };

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}

function appendResult(result) {
  const li = document.createElement('li');
  li.className = result.status;
  li.textContent = `${names[result.status]} · ${result.name} — ${result.reason}`;
  li.title = result.file;
  $('results').append(li);
}

function selectPoint(lat, lon, moveView = false) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('请输入有效的 WGS84 纬度和经度。');
  position = { lat, lon };
  $('lat').value = lat.toFixed(7);
  $('lon').value = lon.toFixed(7);
  $('chosen-point').textContent = `已选 WGS84：纬度 ${lat.toFixed(7)}，经度 ${lon.toFixed(7)}`;
  if (map) {
    if (!marker) {
      marker = L.marker([lat, lon], { draggable: true }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng().wrap(); selectPoint(p.lat, p.lng); });
    } else marker.setLatLng([lat, lon]);
    if (moveView) map.setView([lat, lon], 16);
  }
}

async function initMap() {
  if (map || mapDisabled) return;
  try {
    const config = await api.mapConfig();
    map = L.map('map').setView([31.23, 121.47], 11);
    const tiles = L.tileLayer(config.tileUrl, {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
    }).addTo(map);
    let tileFailed = false;
    $('map-message').textContent = '正在加载地图…';
    tiles.on('loading', () => {
      tileFailed = false;
      $('map-message').textContent = '正在加载地图…';
      $('map-message').className = 'hint';
    });
    tiles.on('tileerror', () => {
      tileFailed = true;
      $('map-message').textContent = '地图瓦片加载失败，请检查网络；可继续搜索或补充输入已知 WGS84 坐标。';
      $('map-message').className = 'hint error';
    });
    tiles.on('load', () => {
      if (!tileFailed) {
        $('map-message').textContent = '点击地图选点，拖动标记微调位置。';
        $('map-message').className = 'hint';
      }
    });
    map.on('click', event => {
      if (processing) return;
      const p = event.latlng.wrap();
      selectPoint(p.lat, p.lng);
    });
    if (position) selectPoint(position.lat, position.lon, true);
  } catch (error) {
    mapDisabled = true;
    $('map-message').textContent = `地图初始化失败：${error.message}`;
    $('map-message').className = 'hint error';
  }
}

$('photos').addEventListener('click', async () => {
  try {
    const files = await api.selectPhotos();
    $('photo-count').textContent = files.length ? `${files.length} 张照片` : '未选择照片';
    $('photo-list').replaceChildren(...files.map(name => { const li = document.createElement('li'); li.textContent = name; return li; }));
  } catch (error) { status(error.message, true); }
});
$('gpx').addEventListener('click', async () => {
  try { $('gpx-name').textContent = (await api.selectGpx()) || '未选择轨迹'; }
  catch (error) { status(error.message, true); }
});
document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', async () => {
  const manual = mode() === 'manual';
  $('manual-panel').hidden = !manual;
  $('gpx-panel').hidden = manual;
  if (manual) {
    await initMap();
    map?.invalidateSize();
  }
}));

$('search').addEventListener('click', async () => {
  $('search').disabled = true;
  $('search-results').replaceChildren();
  try {
    status('正在搜索地点…');
    const results = await api.searchPlace($('query').value);
    for (const item of results) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.name;
      button.addEventListener('click', () => selectPoint(item.lat, item.lon, true));
      $('search-results').append(button);
    }
    status(results.length ? '选择搜索结果，再点击地图或拖动标记调整位置。' : '没有找到地点，请尝试更具体的名称。');
  } catch (error) { status(error.message, true); }
  finally { $('search').disabled = false; }
});
$('query').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('search').disabled) $('search').click(); });
$('set-point').addEventListener('click', () => {
  try {
    if (!$('lat').value.trim() || !$('lon').value.trim()) throw new Error('请同时填写纬度和经度。');
    selectPoint(Number($('lat').value), Number($('lon').value), true);
  } catch (error) { status(error.message, true); }
});
// Edited coordinate fields must be applied explicitly before writing.
for (const id of ['lat', 'lon']) $(id).addEventListener('input', () => {
  position = null;
  if (marker) { marker.remove(); marker = null; }
  $('chosen-point').textContent = '坐标已修改，请点击“使用坐标”确认选点。';
});

api.onProgress(progress => {
  $('progress').value = progress.completed;
  $('progress').max = progress.total;
  status(`正在处理 ${progress.completed} / ${progress.total}`);
  appendResult(progress.result);
});
$('run').addEventListener('click', async () => {
  if (processing) return;
  if (mode() === 'manual' && !position) { status('请先指定地点。', true); return; }
  processing = true;
  $('controls').disabled = true;
  marker?.dragging.disable();
  $('results').replaceChildren();
  $('summary').textContent = '';
  $('progress').hidden = false;
  $('progress').value = 0;
  $('progress').max = 1;
  status('正在读取照片并写入…');
  try {
    const output = await api.runBatch({ mode: mode(), zone: $('zone').value, overwrite: $('overwrite').checked, position });
    const counts = { success: 0, skipped: 0, failed: 0 };
    output.results.forEach(result => counts[result.status]++);
    status(`处理完成：成功 ${counts.success}，跳过 ${counts.skipped}，失败 ${counts.failed}`);
    $('summary').textContent = output.trackInfo || '';
  } catch (error) { status(error.message, true); }
  finally {
    processing = false;
    $('controls').disabled = false;
    marker?.dragging.enable();
    $('progress').hidden = true;
  }
});
