# Apple 照片时区判定问题：排查发现

更新：2026-10-13（当晚追加第八节）。本文记录「相机 JPEG 经 image-mapper 定位后导入 iCloud / Apple 照片，时区被判成上海 +08、排序错乱」这一问题的完整排查过程、字段证据和结论。

**先读第八节的最终结论**：真正的决定变量是**导入通道**（Mac 本地导入 vs Windows→iCloud 同步），不是文件字段。第三~七节是推理轨迹，其中「补 OffsetTime 即可根治」的结论只在 Mac 本地导入下成立，在实际 Windows→iCloud 流程下不成立，已被第八节更新。image-mapper 的文件写入已正确且完整，无需再改。

## 一、现象

- 流程：Windows 上用 image-mapper 给 Sony 相机 JPEG 补位置和时区 → 文件复制进 iCloud 照片 → Mac / iPhone 的 Apple 照片同步显示。
- 一张在日本日光（栃木县）拍的照片 `DSC06274.JPG`，拍摄墙上时间 11:57:36，程序正确写入 `OffsetTimeOriginal=+09:00`。
- Apple 照片却把它判成 **China Standard Time / Shanghai (+08)**。
- 在 Apple 的「调整日期与时间」对话框里把时区从上海改成日本 (+09) 时，墙上时间被 **+1 小时** 改成 12:57:36（本应纹丝不动仍是 11:57）。
- 对同一文件 duplicate 出的多份拷贝，Apple 能显示出 +08 / +09 两种结果。
- 对照：iPhone 直拍、直接进 iCloud 的照片（无论在中国还是日本拍），时间和时区一律正确。

## 二、关键验证：文件本身是正确的

对桌面上同一张照片的三份导出拷贝（含被 Apple「改过时区」后再导出的）逐字节比对，**三份完全相同**：EXIF 全部 46968 字节一致，`OffsetTimeOriginal` 都是 `+09:00`，文件大小、mtime 都相同。

**结论：Apple 的「照片时区」不写回文件，存在它自己的图库数据库里，与 EXIF 脱钩。** 同一个文件能被 Apple 显示成两个时区，证明问题在 Apple 的解释逻辑，不在文件内容。

image-mapper 写入的数据经核对完全自洽、正确：

- `DateTimeOriginal = 2026:10:01 11:57:36`（墙上时间，未平移）
- `OffsetTimeOriginal = +09:00`
- `GPSDateStamp / GPSTimeStamp = 2026:10:01 / 02:57:36`（UTC，= 11:57 − 9h，正确）
- `GPSMapDatum = WGS-84`，坐标在日光境内

任何正确读取 EXIF 的软件都会得到「日本时间 11:57」。

## 三、根因（已实测确认）：Apple 读的是 `OffsetTime`，不是 `OffsetTimeOriginal`

拿 iPhone 直拍的金标准 `IMG_0374.HEIC`（iPhone 16 Pro，同日同地）与相机 JPEG 对照，时间/时区字段差异如下：

| 字段 | 相机 JPEG（Apple 判错） | iPhone HEIC（Apple 判对） |
|---|---|---|
| `DateTimeOriginal` | `2026:10:01 11:57:36` | `2026:10:01 11:55:46` |
| `CreateDate` (Digitized) | `2026:10:01 11:57:36` | `2026:10:01 11:55:46` |
| `ModifyDate` (DateTime) | `2026:10:01 11:57:36` | `2026:10:01 11:55:46` |
| `OffsetTimeOriginal` | `+09:00` | `+09:00` |
| **`OffsetTime`** | **空（未写）** | **`+09:00`** |
| **`OffsetTimeDigitized`** | **空（未写）** | **`+09:00`** |
| `SubSecTimeOriginal` | 空 | `132` |

EXIF 里有三组「时间 + 配套偏移」，一一对应：

| 时间字段 | 配套偏移 | 含义 |
|---|---|---|
| `DateTimeOriginal` (0x9003) | `OffsetTimeOriginal` (0x9011) | 拍摄瞬间 |
| `DateTimeDigitized` / `CreateDate` (0x9004) | `OffsetTimeDigitized` (0x9012) | 数字化瞬间 |
| `DateTime` / `ModifyDate` (0x0132) | `OffsetTime` (0x9010) | 文件（最泛化的）时间 |

image-mapper 目前只写了 `OffsetTimeOriginal`——从 EXIF 标准角度这是最该写、也正确的那个。但 iPhone **三个都写**，而 Apple 照片在判定「照片归属哪个时区」时，**疑似优先读 `OffsetTime`（对应 `DateTime`），而不是 `OffsetTimeOriginal`**，且在它想读的字段为空时**不回退**去读 `OffsetTimeOriginal`，而是用账户 / 设备默认时区兜底（落到上海 +08）。

这能解释全部现象：iPhone 三个偏移齐全 → 永远对；相机 JPEG 只有 `OffsetTimeOriginal` → Apple 读不到它要的 `OffsetTime` → 兜底成上海。被判成 +08 后，Apple 把 11:57 当成「上海 11:57」存成错误的 UTC 03:57；之后改时区成 +09，就用错误的 03:57 换算出 12:57，多出来的 1 小时正是 8↔9 之差。

> 2026-10-13 已实测确认此假设成立。在 Mac 上用官方 exiftool（Perl 版，与项目 vendored 同为 13.59）复制一份样本副本，补写 `OffsetTime=+09:00` 和 `OffsetTimeDigitized=+09:00`（`-overwrite_original_in_place -P`，像素 MD5 不变、无 `_original` 备份、墙上时间仍 11:57），导入 Apple 照片后**直接判成日本 +09、时间显示 11:57，不再兜底上海**。此前「系统时区兜底」「账户默认时区」「读 XMP」三个假设均被证据推翻；XMP 假设被 iPhone HEIC 同样无 XMP 块否定——Apple 判对靠的是 EXIF，不是 XMP。
>
> 补充：该样本的 Sony 相机直出 JPEG 本就不写 `OffsetTime`，原 image-mapper 也只补 `OffsetTimeOriginal`，故此字段始终为空。这说明相机直出 JPEG 不经补写直接进 Apple 同样会中招；补齐三个偏移后即可根治。

## 四、已实施的改动

`metadata.js` 的 `writeMetadata` 中，原来的单行
```js
`-EXIF:OffsetTimeOriginal=${time.offset}`
```
已扩成三行，三个偏移填同一个 `time.offset`：
```js
`-EXIF:OffsetTimeOriginal=${time.offset}`,
`-EXIF:OffsetTime=${time.offset}`,
`-EXIF:OffsetTimeDigitized=${time.offset}`
```
语义安全性：`OffsetTime` 修饰 `DateTime`、`OffsetTimeDigitized` 修饰 `DateTimeDigitized`。相机里拍摄 / 数字化 / 文件时间是同一时刻，都应为拍摄地偏移，故三者填同值合理。image-mapper 不改像素、不平移拍摄时间，不存在三者需不同的情形。

## 五、验证步骤（改程序前必做）

今天已被证据打脸多次，务必先实测，不要直接改。

1. 在 Windows（已装 `exiftool-vendored`）上，对一张样本副本执行：
   ```
   exiftool -OffsetTime="+09:00" -OffsetTimeDigitized="+09:00" DSC06274.JPG
   ```
2. 把结果导入 iCloud / Apple 照片，看是否**直接判成日本 +09、墙上时间显示 11:57**。
3. 若认 → 根因确认，按第四节改 `writeMetadata`。若仍不认 → 写入侧无解（Apple 可能依赖 iPhone 专有信息），只能导入后在 Apple 照片里批量校正（多选 → 批量平移 −1 小时 → 时区设日本）。

（本机 Mac 未装 exiftool，项目依赖 `exiftool-vendored.exe` 为 Windows 版无法在 Mac 运行；桌面文件的 EXIF 由自写 Python 解析器只读 dump，未写入或修改任何文件。）

## 六、其余差异（判断为与本问题无关，但一并记录）

对照 iPhone HEIC 时顺带发现的其他差异，目前判断都**不是**时区问题的原因，不建议为它们改动程序；仅备查：

- **容器格式**：iPhone 为 HEIC（ISOBMFF + HEVC），相机为 JPEG（JFIF）。与时区判定无关。
- **亚秒**：iPhone 写了 `SubSecTimeOriginal/Digitized = 132`；本样本相机 JPEG 无亚秒。程序设计为「保留原亚秒」，相机未写则无从保留，非 bug。（README 曾验证过另一样本的 `001` 亚秒被保留。）
- **GPS 丰富度**：iPhone 额外写了 `Altitude (1388 m)`、`Speed (0)`、`ImgDirection / DestBearing (202.65°)`、`HPositioningError (4.75 m)` 等。image-mapper 按既定规则**不伪造高度、速度、方向、精度**，故只写经纬度、Ref、MapDatum、GPS 时间戳。这是有意为之，不改。
- **`GPSMapDatum`**：相机 JPEG 写了 `WGS-84`，iPhone 未写（Apple 默认即 WGS84）。程序显式写出更稳妥，保留。
- **`GPSVersionID`**：相机 JPEG 有 `02 03 00 00`，iPhone 无。来自原厂 / 写入工具，无关。
- **GPS 坐标**：两者在同一区域、相差约数十米——分别是各自设备 / 轨迹的定位结果，正常。
- **`Software`**：相机 `ILCE-6300 v2.01`，iPhone `27.0`（iOS 版本）。无关。
- **EXIF / 文件体积**：iPhone EXIF 889610 B（含大段 Apple MakerNotes 等），相机 EXIF 46968 B。体积差异与时区判定无关。

## 七、现状结论（已被第八节更新，保留作推理轨迹）

- image-mapper 的写入在 EXIF 标准意义上**正确且完整**，问题根源在 Apple 照片的时区解释逻辑。
- 唯一有望从写入侧改善的着力点是第三节的假设（补写 `OffsetTime` / `OffsetTimeDigitized`），**但必须先按第五节实测确认 Apple 是否采信**，再决定是否改 `metadata.js`。
- 若实测不认，则这是 Apple 侧问题，程序无解，只能导入后在 Apple 照片中批量校正。

> ⚠️ 第三~七节「补 OffsetTime 即可根治」的结论**不完整，且在实际 Windows→iCloud 流程下不成立**。见第八节。它仅在「Mac 本地导入」这一条通道下成立。

## 八、决定性更新：真正的变量是「导入通道」，不是文件字段（2026-10-13 当晚）

第三节的实测（补 `OffsetTime` 后导入即判对）其实是用**单张文件、经某条通道**验证的，当时未控制「通过哪条通道导入」这个变量。后续在真实流程下复现失败，逼出了真正的根因。

### 8.1 复现失败

用**新版 image-mapper**（已写全三个 offset + `GPSAltitude`）处理整批 Sony JPEG，经**正常流程**（Windows 处理 → 复制进 Windows 版 iCloud → 自动同步到 Apple 照片）入库。抽查 `DSC06236.JPG`：

- 文件经 exiftool **全量** dump（含 Sony MakerNotes、所有 IFD、Composite）确认：`OffsetTime/OffsetTimeOriginal/OffsetTimeDigitized` 全 `+09:00`，墙上时间 11:40:46，`GPSTimeStamp` 02:40:46Z，`GPSAltitude` 1388.4m，坐标在日光，`SonyDateTime` 也是 11:40:46。**文件三重时区线索齐全、全部正确、无任何矛盾或隐藏字段**（Sony `ZoneMatching: ISO Setting Used` 是白平衡/ISO 设置，非地理时区）。
- 可文件进 Apple 后**仍被判成 China Standard Time / Shanghai (+08)**，与补 offset 之前一模一样。

即「文件完全正确，照样判错」。

### 8.2 决定性对照实验：同一文件，只换导入通道

把**同一个** `DSC06236.JPG`（及后来整批 `photo_261001/`，37 张）**直接拖进 Mac 的「照片」App 本地导入**：

- **一次判对**：Time Zone = Japan Standard Time / Imaichi，墙上时间 11:40（`DSC06211` 同样一次判对，11:10）。
- Adjust 框里 `Original == Adjusted`、无「−1 hour」、`Revert` 置灰——Apple 认为「无需调整」。

对比两条通道（文件逐字节相同、offset 相同）：

| 入库通道 | 结果 |
|---|---|
| Windows 复制进 iCloud 文件夹 → 自动同步 | ❌ 判成上海 +08 |
| Mac「照片」App 本地拖入 | ✅ 一次判对日本 +09 |

**唯一变量是导入通道。** 结论随之修正：

- **补 `OffsetTime` 本身是必要且正确的**（Mac 本地导入确实靠它一次判对），但**对 Windows→iCloud 通道无效**——该通道无视文件里全部三重时区线索（offset / GPS 时间戳 / GPS 坐标），直接套账户默认时区（上海）。
- **根因在 Apple 的导入通道差异**：macOS 本地「照片」导入器会读 EXIF 时区并正确计算；iCloud（Windows 客户端 / 服务器侧）摄取管线不读，兜底账户时区。
- 时区存在 Apple **图库数据库**（Mac 本地为 `Photos Library.photoslibrary` 内 SQLite 的时区偏移列；iCloud 为云端库），**不写回文件**。导入时钉死，之后不回看文件——所以改文件对已入库照片无效。

### 8.3 `Revert` 现象（重要旁证）

对一张被判成上海的照片（如 `DSC06233`，显示 10:38、Shanghai），在 Adjust 框：

- `Original` 显示的是**正确的** 11:38（Apple 其实把墙上时间读对了，只是配了错时区显示成 10:38）。
- **`Revert` 可点（非灰）**，而 iPhone 原生照片的 `Revert` 是**灰的**。

这说明：Apple 认为这张照片**身上带着一个「它自己施加过的调整」**（把 +09 掰成 +08），该调整记录在 Apple 库里、不在文件里；`Revert` 能把显示改回正确，正是因为它撤销的就是这个 Apple 施加的错误调整。进一步印证「错误在 Apple 库的时区记录，不在文件」。

### 8.4 已排除/确认无效的修复手段

- **改 Windows 系统时区为 +9**：无效（判时区的代码在云端，不读 Windows 系统时区）。
- **文件层面再加字段**：无从下手——文件已有 offset / GPS 时间戳 / GPS 坐标三条独立线索均指向 +09，该通道一条都不读。
- **Apple 内批量 Revert**：不支持（无法批量）。
- **Apple 内改 Closest City 为日本**：该下拉在当前照片上改不动。
- **逐张 Revert**：有效但量大时不现实。
- **Mac 本地重新导入**：✅ 有效（让 Apple 走会读 offset 的通道重算并覆盖库中时区）。但主力处理在 Windows，这不是可持续的「正经方案」。

### 8.5 待办

- 存量「已被判成上海」的照片：目前唯一可靠修复是让 Apple 走本地导入重算（Mac 拖入），逐张 Revert 太苦、批量手段均不可用。
- 以后的新照片：需要一条「Windows 处理后仍能让 Apple 正确计算时区」的可持续入库通道，或确认这是 iCloud for Windows 的已知缺陷、据此调整处理流程。**下一步：联网检索该现象是否为已知 Apple/iCloud bug 及有无社区验证过的正经解法。**
- image-mapper 本身**无需再改**——文件写入已正确且完整；此问题在 Apple 导入侧，非程序可控。
