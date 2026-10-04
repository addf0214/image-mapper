const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const exiftoolPath = require('exiftool-vendored.exe');
const { validateZone, photoTime, coordinates, parseGpx, matchGpx } = require('./location');

function exiftool(args) {
  return new Promise((resolve, reject) => {
    // UTF-8 argument file avoids Windows command-line code-page conversion.
    const child = spawn(exiftoolPath, ['-charset', 'filename=UTF8', '-@', '-'], {
      windowsHide: true, shell: false,
      env: { ...process.env, LC_ALL: 'C', LC_CTYPE: 'C', LANG: 'C' }
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => reject(new Error(`无法启动 ExifTool：${error.message}`)));
    child.stdin.on('error', error => reject(new Error(`ExifTool 输入失败：${error.message}`)));
    child.on('close', code => {
      if (code !== 0 || /(^|\n)Error:/i.test(stderr)) reject(new Error(stderr.trim() || stdout.trim() || `ExifTool 退出码 ${code}`));
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
  const { stdout, warning } = await exiftool(['-j', '-G1', '-n', '-api', 'StructFormat=JSONQ', '-EXIF:DateTimeOriginal', '-EXIF:SubSecTimeOriginal', '-EXIF:OffsetTimeOriginal', '-GPS:all', '-XMP-exif:GPS*', file]);
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
    // Replace the GPS block and XMP GPS tags: old altitude, accuracy, speed,
    // direction and timestamps must not describe the newly assigned location.
    '-GPS:all=', '-XMP-exif:GPS*=',
    `-EXIF:GPSLatitude=${Math.abs(position.lat)}`,
    `-EXIF:GPSLatitudeRef=${position.lat < 0 ? 'S' : 'N'}`,
    `-EXIF:GPSLongitude=${Math.abs(position.lon)}`,
    `-EXIF:GPSLongitudeRef=${position.lon < 0 ? 'W' : 'E'}`,
    '-EXIF:GPSMapDatum=WGS-84',
    `-EXIF:OffsetTimeOriginal=${time.offset}`
  ];
  if (mode === 'gpx') {
    const utc = time.utc.replace(/Z$/, '');
    const [date, clock] = utc.split('T');
    args.push(`-EXIF:GPSDateStamp=${date.replaceAll('-', ':')}`, `-EXIF:GPSTimeStamp=${clock}`);
  }
  args.push(file);
  const output = await exiftool(args);
  if (!/1 image files updated/.test(output.stdout)) throw new Error(output.stdout.trim() || 'ExifTool 未确认文件写入成功。');
  return output.warning;
}

async function runBatch({ files, zone, mode, gpxPath, position, overwrite }, progress = () => {}) {
  validateZone(zone);
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
      if (hasGps(tags) && !overwrite) result = { status: 'skipped', reason: '已有 GPS，未覆盖。' };
      else {
        let time, target;
        try {
          time = photoTime(tags, zone);
          target = mode === 'gpx' ? matchGpx(track, time.ns) : position;
        } catch (error) {
          result = { status: 'skipped', reason: error.message };
        }
        if (!result) {
          const writeWarning = await writeMetadata(file, target, time, mode);
          result = { status: 'success', reason: `已写入 WGS84；拍摄时区 ${time.offset}${warning || writeWarning ? '；警告：' + [warning, writeWarning].filter(Boolean).join('；') : ''}` };
        }
      }
    } catch (error) { result = { status: 'failed', reason: error.message }; }
    results.push({ file, name: path.basename(file), ...result });
    progress({ completed: index + 1, total: files.length, result: results.at(-1) });
  }
  return { results, trackInfo: track ? `${track.pointCount} 个轨迹点，${track.segments.length} 个连续段；${track.missingTimes} 个无时间点已作为断点。` : null };
}

module.exports = { exiftool, readMetadata, writeMetadata, runBatch };
