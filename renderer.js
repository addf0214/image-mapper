const api = window.imageMapper;
const $ = id => document.getElementById(id);
let map, marker, position = null, mapDisabled = false, processing = false;
const mode = () => document.querySelector('input[name="mode"]:checked').value;
const names = { success: '成功', skipped: '跳过', failed: '失败' };
const batchResults = new Map();
const thumbnails = new Map();
let photoRevision = 0;
let photoFiles = [];
const selectedIds = new Set();

function updateSelection() {
  $('photo-count').textContent = `待处理 ${photoFiles.length} 张 · 选中 ${selectedIds.size} 张`;
  $('run').textContent = `写入选中的 ${selectedIds.size} 张`;
  $('run').disabled = processing || !selectedIds.size;
  $('select-all').disabled = $('select-none').disabled = $('clear-photos').disabled = processing || !photoFiles.length;
  for (const card of $('photo-grid').children) {
    const checked = selectedIds.has(card.dataset.id);
    card.classList.toggle('selected', checked);
    card.querySelector('.photo-preview').setAttribute('aria-pressed', String(checked));
    card.querySelector('.selection-mark').textContent = checked ? '✓ 已选' : '未选';
  }
}

function togglePhoto(id) {
  if (processing) return;
  selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
  updateSelection();
}

function clearPoint() {
  position = null;
  if (marker) { marker.remove(); marker = null; }
  $('lat').value = $('lon').value = '';
  $('chosen-point').textContent = '请为下一批照片重新指定地点。';
  $('write-target').textContent = '直接修改所选原文件；请先确认本批地点。';
}

function choiceControls(result) {
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
      if (batchResults.has(updated.id)) {
        $('results').querySelector(`[data-id="${updated.id}"]`)?.remove();
        appendResult(updated);
        showCounts();
      } else status(`${names[updated.status]} · ${updated.name} — ${updated.reason}`);
    } catch (error) { status(error.message, true); }
    finally {
      selectedIds.clear();
      try { await renderPhotos(await api.listPhotos()); }
      catch (error) { status(error.message, true); }
      if (mode() === 'manual') clearPoint();
      setProcessing(false);
    }
  });
  row.append(select, button);
  return row;
}

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
  $('results').append(li);
}

function setProcessing(value) {
  processing = value;
  $('controls').disabled = value;
  for (const control of document.querySelectorAll('.choice-row select, .choice-row button')) {
    control.disabled = value || (control.tagName === 'BUTTON' && control.previousElementSibling.value === '');
  }
  for (const control of document.querySelectorAll('.photo-preview, .remove-photo')) control.disabled = value;
  if (marker) value ? marker.dragging.disable() : marker.dragging.enable();
  updateSelection();
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
  photoFiles = files;
  for (const id of selectedIds) if (!selected.has(id)) selectedIds.delete(id);
  for (const id of thumbnails.keys()) if (!selected.has(id)) thumbnails.delete(id);
  $('photo-empty').hidden = files.length > 0;
  $('photo-grid').replaceChildren();
  const previews = new Map();
  for (const file of files) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.dataset.id = file.id;
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'photo-preview';
    preview.setAttribute('aria-label', `选择 ${file.name}`);
    preview.addEventListener('click', () => togglePhoto(file.id));
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
    remove.title = `将 ${file.name} 移出列表（不删除文件）`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => {
      if (processing) return;
      try { await renderPhotos(await api.removePhoto(file.id)); }
      catch (error) { status(error.message, true); }
    });
    caption.append(name, remove);
    card.append(preview, caption);
    const mark = document.createElement('div');
    mark.className = 'selection-mark';
    card.append(mark);
    if (file.result) {
      const note = document.createElement('p');
      note.className = `photo-result ${file.result.status}`;
      note.textContent = `${file.result.choices ? '待选择匹配' : names[file.result.status]} · ${file.result.reason}`;
      card.append(note);
      if (file.result.choices) card.append(choiceControls(file.result));
    }
    $('photo-grid').append(card);
  }
  setProcessing(processing);
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
  $('write-target').textContent = `目标 WGS84：${lat.toFixed(5)}, ${lon.toFixed(5)} · 直接修改所选原文件`;
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
    const wasEmpty = !photoFiles.length;
    const files = await api.selectPhotos();
    if (wasEmpty) for (const file of files) selectedIds.add(file.id);
    await renderPhotos(files);
  } catch (error) { status(error.message, true); }
  finally { $('photos').disabled = false; }
});
$('select-all').addEventListener('click', () => {
  for (const file of photoFiles) selectedIds.add(file.id);
  updateSelection();
});
$('select-none').addEventListener('click', () => {
  selectedIds.clear();
  updateSelection();
});
$('clear-photos').addEventListener('click', async () => {
  try { await renderPhotos(await api.clearPhotos()); }
  catch (error) { status(error.message, true); }
});
$('gpx').addEventListener('click', async () => {
  try { $('gpx-name').textContent = (await api.selectGpx()) || '未选择轨迹'; }
  catch (error) { status(error.message, true); }
});
document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', async () => {
  const manual = mode() === 'manual';
  $('manual-panel').hidden = !manual;
  $('gpx-panel').hidden = manual;
  $('write-target').textContent = manual && position
    ? `目标 WGS84：${position.lat.toFixed(5)}, ${position.lon.toFixed(5)} · 直接修改所选原文件`
    : manual ? '请先确认本批地点。' : '按当前 GPX 定位；直接修改所选原文件。';
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
  $('write-target').textContent = '坐标尚未确认，请点击“使用坐标”。';
});

api.onProgress(progress => {
  $('progress').value = progress.completed;
  $('progress').max = progress.total;
  status(`正在处理 ${progress.completed} / ${progress.total}`);
  appendResult(progress.result);
  const card = $('photo-grid').querySelector(`[data-id="${progress.result.id}"]`);
  if (card) {
    let note = card.querySelector('.photo-result');
    if (!note) { note = document.createElement('p'); card.append(note); }
    note.className = `photo-result ${progress.result.status}`;
    note.textContent = `${names[progress.result.status]} · ${progress.result.reason}`;
  }
});
$('run').addEventListener('click', async () => {
  if (processing) return;
  if (!selectedIds.size) return;
  if (mode() === 'manual' && !position) { status('请先指定地点。', true); return; }
  setProcessing(true);
  batchResults.clear();
  $('results').replaceChildren();
  $('summary').textContent = '';
  $('result-details').open = false;
  $('progress').hidden = false;
  $('progress').value = 0;
  $('progress').max = 1;
  status('正在读取照片并写入…');
  try {
    const output = await api.runBatch({ mode: mode(), position, ids: [...selectedIds] });
    showCounts();
    $('summary').textContent = output.trackInfo || '';
  } catch (error) { status(error.message, true); }
  finally {
    selectedIds.clear();
    if (mode() === 'manual') clearPoint();
    try { await renderPhotos(await api.listPhotos()); }
    catch (error) { status(error.message, true); }
    setProcessing(false);
    $('progress').hidden = true;
  }
});
updateSelection();
