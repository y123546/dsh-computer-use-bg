param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string]$OutPath
)

# Reads text (and where it is) out of an image using the OCR engine Windows already has.
# Everything here is ASCII on purpose: PowerShell 5.1 decodes a .ps1 without a BOM as ANSI,
# and a stray multi-byte character eats the next quote.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$wrt = [System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')
if (-not $wrt) { '{"error":"System.Runtime.WindowsRuntime could not be loaded"}'; exit 1 }

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
if (-not $asTask) { '{"error":"AsTask overload not found"}'; exit 1 }

function Await($operation, $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$StorageFile = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$FileAccessMode = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$BitmapDecoder = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$OcrEngine = [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime]
$StorageStreams = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
$Imaging = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
$Media = [Windows.Media.Ocr.OcrResult, Windows.Media, ContentType = WindowsRuntime]

$file = Await ($StorageFile::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync($FileAccessMode::Read)) $StorageStreams
$decoder = Await ($BitmapDecoder::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) $Imaging

$engine = $OcrEngine::TryCreateFromUserProfileLanguages()
if (-not $engine) { '{"error":"no OCR engine for the user profile languages"}'; exit 1 }

$result = Await ($engine.RecognizeAsync($bitmap)) $Media

$lines = @()
foreach ($line in $result.Lines) {
    $words = @()
    foreach ($word in $line.Words) {
        $r = $word.BoundingRect
        $words += [pscustomobject]@{
            text   = $word.Text
            x      = [math]::Round($r.X, 1)
            y      = [math]::Round($r.Y, 1)
            width  = [math]::Round($r.Width, 1)
            height = [math]::Round($r.Height, 1)
        }
    }
    $lines += [pscustomobject]@{ text = $line.Text; words = $words }
}

$payload = [pscustomobject]@{
    language = $engine.RecognizerLanguage.LanguageTag
    width    = $decoder.PixelWidth
    height   = $decoder.PixelHeight
    text     = $result.Text
    lines    = $lines
}

$json = $payload | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutPath, $json, (New-Object System.Text.UTF8Encoding($false)))
'{"ok":true}'
