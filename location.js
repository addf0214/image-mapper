const { Temporal } = require('@js-temporal/polyfill');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { find: findZones } = require('geo-tz/all');

const MAX_GAP_SECONDS = 120;

function photoWallTime(tags) {
  const raw = tags['ExifIFD:DateTimeOriginal'];
  const match = typeof raw === 'string' && raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error('缺少有效的 EXIF 拍摄时间 DateTimeOriginal。');
  const fraction = String(tags['ExifIFD:SubSecTimeOriginal'] ?? '').trim();
  if (fraction && !/^\d{1,9}$/.test(fraction)) throw new Error('拍摄亚秒格式无效（支持 1–9 位）。');
  const [, y, m, d, h, min, s] = match;
  try {
    return Temporal.PlainDateTime.from(`${y}-${m}-${d}T${h}:${min}:${s}${fraction ? '.' + fraction : ''}`, { overflow: 'reject' });
  } catch {
    throw new Error('拍摄时间的日期或时分秒无效。');
  }
}

function timesInZone(plain, zone) {
  const candidates = [];
  for (const disambiguation of ['earlier', 'later']) {
    const zoned = plain.toZonedDateTime(zone, { disambiguation });
    // A DST gap has no instant with the original wall time. A fold has two.
    if (!zoned.toPlainDateTime().equals(plain)) continue;
    if (!/^[+-]\d{2}:\d{2}$/.test(zoned.offset)) throw new Error('该历史时区偏移精度无法用 EXIF 时区字段表示。');
    if (!candidates.some(time => time.ns === zoned.epochNanoseconds)) {
      candidates.push({ ns: zoned.epochNanoseconds, offset: zoned.offset, utc: zoned.toInstant().toString(), zone });
    }
  }
  return candidates;
}

const zoneCache = new Map();

function zonesAt(position) {
  // Cache by exact coordinate: locatePhoto re-checks the same candidate across
  // its zone/time loops, and tracks repeat identical points, so the same lookup
  // recurs. Exact key keeps the result identical to an uncached call.
  const key = `${position.lat},${position.lon}`;
  let zones = zoneCache.get(key);
  if (!zones) {
    zones = findZones(position.lat, position.lon);
    if (!zones.length) throw new Error('无法确定该地点的时区。');
    zoneCache.set(key, zones);
  }
  return zones;
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
  let missingTimes = 0, duplicatePoints = 0;
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
        const previous = run[run.length - 1];
        if (previous && ns === previous.ns) {
          if (position.lat !== previous.lat || position.lon !== previous.lon) throw new Error(`GPX 同一轨迹段在 ${time} 存在相同时间但不同位置的记录。`);
          duplicatePoints++;
          continue;
        }
        if (previous && ns < previous.ns) throw new Error(`GPX 同一轨迹段在 ${time} 存在倒序时间。`);
        run.push({ ...position, ns });
      }
      if (run.length) segments.push(run);
    }
  }
  if (!segments.length) throw new Error('GPX 没有带有效时间的轨迹点（仅支持 trk/trkseg）。');
  const zones = [...new Set(segments.flatMap(segment => segment.flatMap(zonesAt)))];
  return { segments, zones, missingTimes, duplicatePoints, pointCount: segments.reduce((n, s) => n + s.length, 0) };
}

function positionsAt(track, ns) {
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
  return matches;
}

function locatePhoto(tags, track, position) {
  const plain = photoWallTime(tags);
  const matches = [];
  for (const zone of track ? track.zones : zonesAt(position)) {
    for (const time of timesInZone(plain, zone)) {
      for (const target of track ? positionsAt(track, time.ns) : [position]) {
        if (track && !zonesAt(target).includes(zone)) continue;
        if (matches.some(match => match.time.ns === time.ns && Math.abs(match.position.lat - target.lat) < 1e-9 && Math.abs(match.position.lon - target.lon) < 1e-9)) continue;
        matches.push({ position: target, time });
      }
    }
  }
  if (!matches.length) throw new Error(track
    ? `无法匹配：当地拍摄时间不在连续轨迹内、间隔超过 ${MAX_GAP_SECONDS} 秒，或当地时间不存在。`
    : '拍摄墙上时间在该地点不存在（夏令时跳时），已跳过。');
  return matches;
}

module.exports = { coordinates, parseGpx, locatePhoto };
