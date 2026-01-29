<# 
zip_from_zipjson.ps1
- zip.json に書かれたパスだけを zip 化（相対パス前提）
- 既定: カレントディレクトリを SourceRoot として扱う
- 構造: 配下の相対パスを保ったまま zip へ格納

zip.json の形式は以下どちらでもOK:
1) 配列:
[
  "src/main.ts",
  "src/style.css"
]
2) オブジェクト（files / include / paths のいずれか）:
{ "files": ["src/main.ts", "src/style.css"] }
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$ZipJsonPath = "zip.json",

  [Parameter(Mandatory = $false)]
  [string]$OutZipPath = "",

  [Parameter(Mandatory = $false)]
  [string]$SourceRoot = "",

  [Parameter(Mandatory = $false)]
  [switch]$FailOnMissing
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPath([string]$path) {
  return [System.IO.Path]::GetFullPath($path)
}

# root を基準に、相対は結合、絶対はそのままフルパス化
function Resolve-UnderRoot([string]$rootFull, [string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) {
    return [System.IO.Path]::GetFullPath($rootFull)
  }
  if ([System.IO.Path]::IsPathRooted($path)) {
    return [System.IO.Path]::GetFullPath($path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $rootFull $path))
}

function Ensure-Directory([string]$dir) {
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }
}


function Get-ListFromZipJson([string]$jsonPath) {
  if (-not (Test-Path -LiteralPath $jsonPath)) {
    throw "zip.json が見つかりません: $jsonPath"
  }

  $raw = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    throw "zip.json が空です: $jsonPath"
  }

  try {
    $obj = $raw | ConvertFrom-Json
  } catch {
    throw "zip.json の JSON 解析 (Parse) に失敗しました: $($_.Exception.Message)"
  }

  # 配列 or オブジェクトの想定プロパティを吸収
  $items = $null
  if ($obj -is [System.Array]) {
    $items = $obj
  } elseif ($null -ne $obj.files) {
    $items = $obj.files
  } elseif ($null -ne $obj.include) {
    $items = $obj.include
  } elseif ($null -ne $obj.paths) {
    $items = $obj.paths
  } else {
    throw "zip.json の形式が不明です。配列 or {files/include/paths:[...]} を想定しています。"
  }

  $list = @()
  foreach ($x in $items) {
    if ($null -eq $x) { continue }
    $s = [string]$x
    $s = $s.Trim()
    if ([string]::IsNullOrWhiteSpace($s)) { continue }
    $list += $s
  }

  # 重複除去（Order維持）
  $seen = @{}
  $uniq = New-Object System.Collections.Generic.List[string]
  foreach ($p in $list) {
    if (-not $seen.ContainsKey($p)) {
      $seen[$p] = $true
      $uniq.Add($p)
    }
  }
  return ,$uniq.ToArray()
}

function Validate-RelativePath([string]$rel) {
  # rooted (絶対パス) と path traversal を拒否
  if ([System.IO.Path]::IsPathRooted($rel)) {
    throw "絶対パスは不可です (Absolute Path): $rel"
  }
  if ($rel -match '(^|[\\/])\.\.([\\/]|$)') {
    throw "相対パスに '..' は不可です (Path Traversal): $rel"
  }
  # ワイルドカードは Literal 前提なので拒否（必要なら仕様拡張）
  if ($rel -match '[\*\?]') {
    throw "ワイルドカード (* ?) は不可です: $rel"
  }
}

function Copy-IntoStage([string]$srcFull, [string]$destFull) {
  $destDir = Split-Path -Parent $destFull
  Ensure-Directory $destDir

  if (Test-Path -LiteralPath $srcFull -PathType Leaf) {
    Copy-Item -LiteralPath $srcFull -Destination $destFull -Force
    return
  }

  if (Test-Path -LiteralPath $srcFull -PathType Container) {
    # ディレクトリ指定も許可：中身を再帰でコピー
    Ensure-Directory $destFull
    Copy-Item -LiteralPath (Join-Path $srcFull "*") -Destination $destFull -Recurse -Force
    return
  }

  throw "存在しないパスです: $srcFull"
}

function Create-Zip-ByCompressArchive([string]$stageDir, [string]$outZip) {
  $cmd = Get-Command Compress-Archive -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    return $false
  }

  if (Test-Path -LiteralPath $outZip) {
    Remove-Item -LiteralPath $outZip -Force
  }

  # stage 直下の内容だけを ZIP ルートにする
  Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $outZip -Force
  return $true
}

function Create-Zip-ByDotNet([string]$stageDir, [string]$outZip) {
  # .NET フォールバック
  Add-Type -AssemblyName System.IO.Compression | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

  if (Test-Path -LiteralPath $outZip) {
    Remove-Item -LiteralPath $outZip -Force
  }

  [System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $outZip)
}

try {
  $root = $SourceRoot
  if ([string]::IsNullOrWhiteSpace($root)) {
    $root = (Get-Location).Path
  }
  $rootFull = Resolve-FullPath $root
  if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
    throw "SourceRoot がディレクトリではありません: $rootFull"
  }

   $zipJsonFull = Resolve-UnderRoot $rootFull $ZipJsonPath
  $relPaths = Get-ListFromZipJson $zipJsonFull
  if ($relPaths.Count -eq 0) {
    throw "zip.json に対象パスがありません。"
  }

  # 出力先 ZIP の既定値（既定は root 配下の _zip_out に相対で作る）
  if ([string]::IsNullOrWhiteSpace($OutZipPath)) {
    $repoName = Split-Path -Leaf $rootFull
    $ts = Get-Date -Format "yyyyMMdd_HHmmss"
    $outDirRel = "_zip_out"
    Ensure-Directory (Join-Path $rootFull $outDirRel)
    $OutZipPath = Join-Path $outDirRel ("{0}_{1}.zip" -f $repoName, $ts)
  }

  $outZipFull = Resolve-UnderRoot $rootFull $OutZipPath
  Ensure-Directory (Split-Path -Parent $outZipFull)


  # ステージング作成
  $stageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("zipfromjson_" + [System.Guid]::NewGuid().ToString("N"))
  Ensure-Directory $stageDir

  $missing = New-Object System.Collections.Generic.List[string]
  $copiedCount = 0

  foreach ($rel in $relPaths) {
    Validate-RelativePath $rel

    $src = Resolve-FullPath (Join-Path $rootFull $rel)

    # root 外へ出ていないかチェック（Case-insensitive）
    if (-not $src.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "SourceRoot 外のパスは不可です: $rel"
    }

    if (-not (Test-Path -LiteralPath $src)) {
      $missing.Add($rel) | Out-Null
      continue
    }

    $dest = Resolve-FullPath (Join-Path $stageDir $rel)
    Copy-IntoStage $src $dest
    $copiedCount++
  }

  if ($missing.Count -gt 0) {
    Write-Warning ("見つからないパス (Missing):`n - " + ($missing -join "`n - "))
    if ($FailOnMissing) {
      throw "不足ファイルがあるため中断しました。-FailOnMissing を外すと不足を無視して続行します。"
    }
  }

  # ZIP 作成
  $ok = Create-Zip-ByCompressArchive $stageDir $outZipFull
  if (-not $ok) {
    Create-Zip-ByDotNet $stageDir $outZipFull
  }

  # 後始末
  Remove-Item -LiteralPath $stageDir -Recurse -Force

  Write-Host ("[OK] ZIP 作成完了: {0}" -f $outZipFull)
  Write-Host ("[OK] 収集パス数: {0} / 有効コピー数: {1} / 不足: {2}" -f $relPaths.Count, $copiedCount, $missing.Count)
} catch {
  Write-Error $_
  exit 1
}
