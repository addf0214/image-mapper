const { Temporal } = require('@js-temporal/polyfill');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const MAX_GAP_SECONDS = 120;

function validateZone(zone) {
  if (typeof zone !== 'string' || !zone.trim() || /^[+-]/.test(zone)) {
    throw new Error('请明确填写相机使用的 IANA 时区，例如 Asia/Tokyo。');
  }
  try {
    Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(zone);
  } catch {
    throw new Error(`无效的相机时区：${zone}`);
  }
}

function photoTime(tags, zone) {
  const raw = tags['ExifIFD:DateTimeOriginal'];
  const match = typeof raw === 'string' && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error('缺少有效的 EXIF 拍摄时间 DateTimeOriginal。');
  const fraction = String(tags['ExifIFD:SubSecTimeOriginal'] ?? '').trim();
  if (fraction && !/^\d{1,9}$/.test(fraction)) throw new Error('拍摄亚秒格式无效（支持 1–9 位）。');
  const [, y, m, d, h, min, s] = match;
  let plain;
  try {
    plain = Temporal.PlainDateTime.from(`${y}-${m}-${d}T${h}:${min}:${s}${fraction ? '.' + fraction : ''}`, { overflow: 'reject' });
  } catch {
    throw new Error('拍摄时间的日期或时分秒无效。');
  }
  let zoned;
  try {
    zoned = plain.toZonedDateTime(zone, { disambiguation: 'reject' });
  } catch {
    throw new Error('拍摄墙上时间在该时区重复或不存在（夏令时切换），已跳过。');
  }
  if (!/^[+-]\d{2}:\d{2}$/.test(zoned.offset)) throw new Error('该历史时区偏移精度无法用 EXIF 时区字段表示。');
  return { ns: zoned.epochNanoseconds, offset: zoned.offset, utc: zoned.toInstant().toString() };
}

function coordinates(lat, lon) {
  if (lat == null || lon == null || String(lat).trim() === '' || String(lon).trim() === '') throw new Error('请指定有效的纬度和经度。');
  const latitude = Number(lat), longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('坐标无效：纬度范围 -90～90，经度范围 -180～180。');
  }
  return { lat: latitude, lon: longitude };
}

function parseGpx(xml) {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('GPX 不支持 DOCTYPE。');
  const valid = XMLValidator.validate(xml);
  if (valid !== true) throw new Error(`GPX XML 格式错误：${valid.err.msg}`);
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false }).parse(xml);
  if (!parsed.gpx) throw new Error('文件不是 GPX。');
  const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
  const segments = [];
  let missingTimes = 0;
  for (const track of array(parsed.gpx.trk)) {
    for (const segment of array(track.trkseg)) {
      let run = [];
      for (const point of array(segment.trkpt)) {
        if (!point.time) {
          missingTimes++;
          if (run.length) segments.push(run);
          run = [];
          continue;
        }
        const time = String(point.time).trim();
        if (!/(Z|[+-]\d{2}:\d{2})$/.test(time)) throw new Error('GPX 轨迹时间缺少明确的 Z 或时区偏移。');
        let ns;
        try { ns = Temporal.Instant.from(time).epochNanoseconds; }
        catch { throw new Error(`GPX 轨迹时间无效：${time}`); }
        const position = coordinates(point['@_lat'], point['@_lon']);
        if (run.length && ns <= run[run.length - 1].ns) throw new Error('GPX 同一轨迹段存在重复或倒序时间。');
        run.push({ ...position, ns });
      }
      if (run.length) segments.push(run);
    }
  }
  if (!segments.length) throw new Error('GPX 没有带有效时间的轨迹点（仅支持 trk/trkseg）。');
  return { segments, missingTimes, pointCount: segments.reduce((n, s) => n + s.length, 0) };
}

function matchGpx(track, ns) {
  const matches = [];
  for (const segment of track.segments) {
    if (ns < segment[0].ns || ns > segment[segment.length - 1].ns) continue;
    let lo = 0, hi = segment.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segment[mid].ns < ns) lo = mid + 1;
      else hi = mid;
    }
    const b = segment[lo];
    if (b.ns === ns) { matches.push({ lat: b.lat, lon: b.lon }); continue; }
    const a = segment[lo - 1];
    if (b.ns - a.ns > BigInt(MAX_GAP_SECONDS) * 1000000000n) continue;
    const ratio = Number(ns - a.ns) / Number(b.ns - a.ns);
    // Use the short arc when a segment crosses the international date line.
    let delta = b.lon - a.lon;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    const lon = ((a.lon + delta * ratio + 540) % 360) - 180;
    matches.push({ lat: a.lat + (b.lat - a.lat) * ratio, lon });
  }
  if (!matches.length) throw new Error(`无法匹配：超出轨迹、位于分段断点或记录间隔超过 ${MAX_GAP_SECONDS} 秒。`);
  if (matches.some(p => Math.abs(p.lat - matches[0].lat) > 1e-9 || Math.abs(p.lon - matches[0].lon) > 1e-9)) {
    throw new Error('多个重叠轨迹段给出不同位置，无法唯一匹配。');
  }
  return matches[0];
}

module.exports = { validateZone, photoTime, coordinates, parseGpx, matchGpx, MAX_GAP_SECONDS };
