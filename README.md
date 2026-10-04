# Image Mapper

Windows 本地应用，只做 PixTrack GPX 照片定位和批量手动定位。支持 Sony ARW、JPG、JPEG（扩展名不区分大小写）。直接修改所选原文件，不生成永久整份照片备份，不重编码图像。

## 启动

需要 Node.js 22.12+ 和 npm。首次安装需要联网下载 Electron 与随项目提供的 ExifTool；无需单独安装 ExifTool。

```powershell
cd C:\Users\Allen\Development\image-mapper
npm install
npm start
```

若 npm 的脚本策略跳过了 Electron 下载，执行 `node node_modules/electron/install.js` 后再启动。本机已安装依赖并完成窗口启动检查。ExifTool 子进程使用 UTF-8 参数输入，支持中文及空格路径。

## 使用

1. 选择一批 ARW / JPEG，明确填写相机拍摄时使用的 IANA 时区，例如 `Asia/Tokyo`、`Asia/Shanghai`、`Europe/Berlin`。不采用电脑时区默认值，跨时区请分批。
2. **GPX 模式**：选择 PixTrack 导出的 GPX；或 **手动模式**：搜索地点、选择结果，点击地图选点或拖动标记微调。也可补充输入已知的 WGS84 经纬度并点击“使用坐标”。
3. 默认跳过已有 GPS 的照片；需要改位置时勾选“覆盖已有位置”。
4. 点击“写入所选原文件”，查看成功、跳过、失败数量及逐文件原因。执行期间请等待完成后再关闭窗口。

拍摄墙上时间及亚秒保持原样。仅写 `OffsetTimeOriginal` 补充相机时区；不改 DateTimeOriginal、CreateDate、ModifyDate 或 MakerNotes。使用 Temporal 按拍摄日期计算夏令时偏移；重复或不存在的本地时间跳过。亚秒以字符串读取，保留前导零；内部支持 1–9 位。缺少有效 EXIF DateTimeOriginal 时跳过，不使用文件修改时间。

GPX 仅解析 `trk/trkseg/trkpt`，按明确的 UTC/偏移时间匹配 WGS84 坐标。精确命中使用该点；同段内按时间插值，相邻点间隔上限固定为 **120 秒**。不跨段、不跨无时间点、不外推。重复／倒序时间报告错误；重叠段位置冲突时跳过对应照片。跨日期变更线采用短方向经度插值。

写入 `GPSLatitude/Ref`、`GPSLongitude/Ref`、`GPSMapDatum=WGS-84`；GPX 模式另写照片对应的 UTC GPSDateStamp / GPSTimeStamp。覆盖时清除 EXIF GPS 块和 XMP-exif GPS 标签后写入新位置，避免残留旧高度、精度、速度、方向及时间。手动定位只写位置、基准及拍摄时区，不伪造高程或 GPS 测量属性。ExifTool 使用 `-overwrite_original_in_place -P`，尽量保留文件系统属性。

## 地图与网络

采用 **Leaflet + OpenStreetMap 标准底图 + Nominatim 搜索**，无需 API Key。底图和搜索坐标均按 WGS84 使用，所以大陆和海外位置都不进行 GCJ-02 转换；GPX 也不因位于中国而转换。补充输入请勿粘贴高德／百度坐标。

这是本机个人照片定位用途的地图方案。**请遵守 [Nominatim 使用政策](https://operations.osmfoundation.org/policies/nominatim/) 和 [OSM 瓦片政策](https://operations.osmfoundation.org/policies/tiles/)**：仅人工触发搜索，无自动补全或批量搜索；搜索间隔至少 1.1 秒、单请求执行、当前会话缓存；瓦片使用应用标识和 Chromium 持久 HTTP 缓存，不预下载或提供离线地图。界面显示 OSM 署名。公共服务可限流或不可用，不能保证所有大陆／海外网络可达；加载、超时或搜索失败会报告，不自动重试。照片与元数据不上传，地图服务仅收到搜索文字、当前地图请求及网络连接信息。请勿搜索个人或保密信息。

为满足服务要求，维护者可通过环境变量切换兼容的服务，无需修改代码：`IMAGE_MAPPER_TILE_URL`（HTTPS OSM 衍生瓦片模板，含 `{z}/{x}/{y}`）及 `IMAGE_MAPPER_SEARCH_URL`（HTTPS Nominatim 兼容 search 接口）。替换服务须仍输出 WGS84、允许此用途且适用现有署名；这不是多供应商地图系统。

## 已验证与待验证（2026-10-04）

未创建自动化测试或测试框架。仅用已有附件的**临时 JPEG 副本**补入拍摄标签和小型临时 GPX，通过命令手动验证；未修改原附件或任何个人原片。

- 已验证 Windows 窗口启动、隔离 preload 接口、两种模式切换、空时区反馈、地图加载、东京和浦东机场搜索、坐标选点及标记显示。
- 已验证临时 JPEG 的 GPX 插值、手动批量写入、已有 GPS 跳过、旧 EXIF／XMP GPS 清理、中文及空格路径、大小写扩展名，以及 `001` 亚秒保留。
- 已验证日本 `13:00 → 内部 UTC 04:00 / +09:00`，德国冬夏 `+01:00 / +02:00`，夏令时重复／不存在时间跳过；精确匹配、分段断点、长间隔、超出范围、重复时间及无时区 GPX 的处理。
- 已验证只读和不存在文件报告失败后继续后续照片；缺失拍摄时间跳过。样本 JPEG 的压缩图像扫描数据 SHA-256、文件创建及修改时间在写入前后相同，未生成 `_original` 副本。
- 搜索曾发生一次超时并明确报错，后续人工搜索成功；网络错误不能保证永不出现。ExifTool 缺失／无法启动和被占用文件有错误处理，尚未单独模拟。
- **尚未验证真实 Sony ARW、真实 PixTrack GPX 和真实跨批次工作流。**临时 JPEG／轨迹验证不代表这些兼容性已确认；原生文件选择弹窗的实际批次选择也待用户操作。
- **尚需用户在 Apple 照片验证**：修改后 ARW／JPEG 的位置、拍摄墙上时间和时区导入显示，以及与 iPhone 原片混用时的位置表现。无法由现有压缩附件判断 iPhone 大陆原片坐标，也不保证 Apple 自动修正非 WGS84 元数据。

提供一小批获授权的 ARW／JPEG 原片和匹配的 PixTrack GPX 本地路径后，可继续用副本手动验证真实输入，并由用户检查 Apple 照片显示。
