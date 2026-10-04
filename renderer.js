const api = window.imageMapper;
const $ = id => document.getElementById(id);
let map, marker, position = null, mapDisabled = false, processing = false;
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const names = { success: '成功', skipped: '跳过', failed: '失败' };
const batchResults = new Map();
const thumbnails = new Map();
let photoRevision = 0;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}

function appendResult(result) {
  batchResults.set(result.id, result);
  const li = document.createElement('li');
  li.dataset.id = result.id;
  li.className = result.status;
  li.textContent = `${names[result.status]} · ${result.name} — ${result.reason}`;
  li.title = result.file;
  if (result.choices) {
    const row = document.createElement('div');
    row.className = 'choice-row';
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${result.name} 的匹配位置`);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '请选择一个匹配…';
    select.append(placeholder);
    result.choices.forEach((choice, index) => {
      const option = document.createElement('option');
      option.value = index;
      option.textContent = `${choice.zone} (${choice.offset}) · ${choice.lat.toFixed(5)}, ${choice.lon.toFixed(5)} · UTC ${choice.utc}`;
      select.append(option);
    });
    const button = document.createElement('button');
    button.textContent = '采用此匹配';
    button.type = 'button';
    button.disabled = true;
    select.addEventListener('change', () => { button.disabled = select.value === ''; });
    button.addEventListener('click', async () => {
      if (processing || select.value === '') return;
      setProcessing(true);
      status('正在写入所选匹配…');
      try {
        const updated = await api.resolveChoice({ id: result.id, index: Number(select.value) });
        li.remove();
        appendResult(updated);
        showCounts();
      } catch (error) { status(error.message, true); }
      finally { setProcessing(false); }
    });
    row.append(select, button);
    li.append(row);
  }
  $('results').append(li);
}

function setProcessing(value) {
  processing = value;
  $('controls').disabled = value;
  for (const control of document.querySelectorAll('.choice-row select, .choice-row button')) {
    control.disabled = value || (control.tagName === 'BUTTON' && control.previousElementSibling.value === '');
  }
  if (marker) value ? marker.dragging.disable() : marker.dragging.enable();
}

function showCounts() {
  const counts = { success: 0, skipped: 0, failed: 0 };
  let unresolved = 0;
  for (const result of batchResults.values()) {
    counts[result.status]++;
    if (result.choices) unresolved++;
  }
  status(`处理完成：成功 ${counts.success}，跳过 ${counts.skipped}，失败 ${counts.failed}${unresolved ? `；${unresolved} 张待选择匹配` : ''}`);
}

async function renderPhotos(files) {
  const revision = ++photoRevision;
  const selected = new Set(files.map(file => file.id));
  for (const id of thumbnails.keys()) if (!selected.has(id)) thumbnails.delete(id);
  $('photo-count').textContent = files.length ? `${files.length} 张已选` : '未选择';
  $('photo-empty').hidden = files.length > 0;
  $('photo-grid').replaceChildren();
  const previews = new Map();
  for (const file of files) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    const preview = document.createElement('div');
    preview.className = 'photo-preview';
    preview.textContent = '正在读取…';
    previews.set(file.id, preview);
    const caption = document.createElement('div');
    caption.className = 'photo-caption';
    const name = document.createElement('span');
    name.textContent = file.name;
    name.title = file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-photo';
    remove.textContent = '×';
    remove.title = `移除 ${file.name}`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => {
      try { await renderPhotos(await api.removePhoto(file.id)); }
      catch (error) { status(error.message, true); }
    });
    caption.append(name, remove);
    card.append(preview, caption);
    $('photo-grid').append(card);
  }
  for (const file of files) {
    if (revision !== photoRevision) return;
    const preview = previews.get(file.id);
    try {
      const source = thumbnails.get(file.id) || await api.photoThumbnail(file.id);
      if (revision !== photoRevision) return;
      thumbnails.set(file.id, source);
      const image = document.createElement('img');
      image.src = source;
      image.alt = file.name;
      preview.replaceChildren(image);
    } catch (error) {
      preview.textContent = '无可用缩略图';
      preview.title = error.message;
    }
  }
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
  $('photos').disabled = true;
  try {
    await renderPhotos(await api.selectPhotos());
  } catch (error) { status(error.message, true); }
  finally { $('photos').disabled = false; }
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
  setProcessing(true);
  batchResults.clear();
  $('results').replaceChildren();
  $('summary').textContent = '';
  $('progress').hidden = false;
  $('progress').value = 0;
  $('progress').max = 1;
  status('正在读取照片并写入…');
  try {
    const output = await api.runBatch({ mode: mode(), position });
    showCounts();
    $('summary').textContent = output.trackInfo || '';
  } catch (error) { status(error.message, true); }
  finally {
    setProcessing(false);
    $('progress').hidden = true;
  }
});
