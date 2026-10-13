const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const exiftoolPath = require('exiftool-vendored.exe');
const { coordinates, parseGpx, locatePhoto } = require('./location');

function exiftool(args, binary = false) {
  return new Promise((resolve, reject) => {
    // UTF-8 argument file avoids Windows command-line code-page conversion.
    const child = spawn(exiftoolPath, ['-charset', 'filename=UTF8', '-@', '-'], {
      windowsHide: true, shell: false,
      env: { ...process.env, LC_ALL: 'C', LC_CTYPE: 'C', LANG: 'C' }
    });
    const chunks = [];
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { chunks.push(data); });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => reject(new Error(`无法启动 ExifTool：${error.message}`)));
    child.stdin.on('error', error => reject(new Error(`ExifTool 输入失败：${error.message}`)));
    child.on('close', code => {
      const buffer = Buffer.concat(chunks);
      const stdout = binary ? buffer : buffer.toString('utf8');
      if (code !== 0 || /(^|\n)Error:/i.test(stderr)) reject(new Error(stderr.trim() || buffer.toString('utf8').trim() || `ExifTool 退出码 ${code}`));
      else resolve({ stdout, warning: stderr.trim() });
    });
    if (args.some(arg => /[\r\n]/.test(arg))) {
      child.kill();
      reject(new Error('ExifTool 参数不能包含换行。'));
      return;
    }
    child.stdin.end(args.join('\n') + '\n', 'utf8');
  });
}

async function readMetadata(file) {
  const { stdout, warning } = await exiftool(['-j', '-G1', '-n', '-api', 'StructFormat=JSONQ', '-EXIF:DateTimeOriginal', '-EXIF:SubSecTimeOriginal', '-GPS:all', '-XMP-exif:GPS*', file]);
  const tags = JSON.parse(stdout)[0];
  if (!tags || tags.Error) throw new Error(tags?.Error || 'ExifTool 未返回照片元数据。');
  return { tags, warning };
}

function hasGps(tags) {
  return Object.keys(tags).some(key => /:GPS(Latitude|Longitude)(Ref)?$/.test(key));
}

async function writeMetadata(file, position, time, mode) {
  const args = [
    '-overwrite_original_in_place', '-P',
    // Remove incomplete GPS remnants before assigning the first location.
    '-GPS:all=', '-XMP-exif:GPS*=',
    `-EXIF:GPSLatitude=${Math.abs(position.lat)}`,
    `-EXIF:GPSLatitudeRef=${position.lat < 0 ? 'S' : 'N'}`,
    `-EXIF:GPSLongitude=${Math.abs(position.lon)}`,
    `-EXIF:GPSLongitudeRef=${position.lon < 0 ? 'W' : 'E'}`,
    '-EXIF:GPSMapDatum=WGS-84',
    // Apple Photos reads OffsetTime (tied to DateTime), not OffsetTimeOriginal,
    // when deciding a photo's time zone; writing only OffsetTimeOriginal leaves
    // it to fall back to the account default (e.g. Shanghai +08). Camera wall
    // time is a single instant, so all three offsets take the same value.
    `-EXIF:OffsetTimeOriginal=${time.offset}`,
    `-EXIF:OffsetTime=${time.offset}`,
    `-EXIF:OffsetTimeDigitized=${time.offset}`
  ];
  if (mode === 'gpx') {
    const utc = time.utc.replace(/Z$/, '');
    const [date, clock] = utc.split('T');
    args.push(`-EXIF:GPSDateStamp=${date.replaceAll('-', ':')}`, `-EXIF:GPSTimeStamp=${clock}`);
    // GPX <ele> is a real GPS measurement, so record it; ref 0/1 = above/below
    // sea level with the magnitude stored as a positive value. Manual mode has
    // no real elevation and never reaches here with an ele.
    if (position.ele != null) {
      args.push(`-EXIF:GPSAltitude=${Math.abs(position.ele)}`, `-EXIF:GPSAltitudeRef=${position.ele < 0 ? 1 : 0}`);
    }
  }
  args.push(file);
  const output = await exiftool(args);
  if (!/1 image files updated/.test(output.stdout)) throw new Error(output.stdout.trim() || 'ExifTool 未确认文件写入成功。');
  return output.warning;
}

async function runBatch({ files, mode, gpxPath, position, selectedChoice }, progress = () => {}) {
  if (!files.length) throw new Error('请先选择照片。');
  if (!['gpx', 'manual'].includes(mode)) throw new Error('无效的处理模式。');
  let track;
  if (mode === 'gpx') {
    if (!gpxPath) throw new Error('请先选择 GPX 文件。');
    track = parseGpx(await fs.readFile(gpxPath, 'utf8'));
  } else position = coordinates(position?.lat, position?.lon);
  await exiftool(['-ver']);
  const results = [];
  for (const [index, file] of files.entries()) {
    let result;
    try {
      if (!/\.(arw|jpe?g)$/i.test(file)) throw new Error('仅支持 ARW / JPEG。');
      const { tags, warning } = await readMetadata(file);
      if (hasGps(tags)) result = { status: 'skipped', reason: '已有 GPS，保留原位置。', alreadyLocated: true };
      else {
        let time, target;
        try {
          const matches = locatePhoto(tags, track, position);
          if (matches.length > 1 && !selectedChoice) {
            result = { status: 'skipped', reason: '存在多个合理匹配，请选择后写入。', choices: matches.map(match => ({
              ...match.position, zone: match.time.zone, offset: match.time.offset, utc: match.time.utc
            })) };
          } else {
            const match = selectedChoice ? matches.find(match => match.time.utc === selectedChoice.utc
              && match.time.zone === selectedChoice.zone && match.position.lat === selectedChoice.lat
              && match.position.lon === selectedChoice.lon) : matches[0];
            if (!match) throw new Error('所选匹配已不可用，请重新处理本批照片。');
            time = match.time;
            target = match.position;
          }
        } catch (error) {
          result = { status: 'skipped', reason: error.message };
        }
        if (!result) {
          const writeWarning = await writeMetadata(file, target, time, mode);
          result = { status: 'success', reason: `已写入 WGS84；${time.zone} (${time.offset})${warning || writeWarning ? '；警告：' + [warning, writeWarning].filter(Boolean).join('；') : ''}` };
        }
      }
    } catch (error) { result = { status: 'failed', reason: error.message }; }
    results.push({ file, name: path.basename(file), ...result });
    progress({ completed: index + 1, total: files.length, result: results.at(-1) });
  }
  return { results, trackInfo: track ? `${track.pointCount} 个轨迹点，${track.segments.length} 个连续段；${track.missingTimes} 个无时间点已作为断点；${track.duplicatePoints} 个同时间同位置重复点已合并。` : null };
}

module.exports = { exiftool, runBatch };
