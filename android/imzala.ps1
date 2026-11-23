# Çini Salonu · Google Play için imzalama
# Bu betiği SEN çalıştır: şifreyi sen belirlersin/yazarsın, kimseye gösterilmez.
#   PowerShell'de:  cd C:\Users\alpou\cini-salonu\android ; powershell -ExecutionPolicy Bypass -File .\imzala.ps1
# İlk çalıştırmada upload.keystore oluşturur (bu klasörde kalır, git'e girmez), sonra derlenmiş paketi imzalar:
#   cikti\cini-salonu.aab  → Google Play Console'a yüklenecek dosya
#   cikti\cini-salonu.apk  → telefona doğrudan kurup denemek için
# ÖNEMLİ: upload.keystore dosyasını ve şifreni yedekle (USB, şifre yöneticisi).
$ErrorActionPreference = 'Stop'
$jdk = Get-ChildItem 'C:\Program Files\Android\openjdk' -Directory | Sort-Object Name -Descending | Select-Object -First 1
$bin = Join-Path $jdk.FullName 'bin'
$ks = Join-Path $PSScriptRoot 'upload.keystore'
$aab = Join-Path $PSScriptRoot 'app\build\outputs\bundle\release\app-release.aab'
$apk = Join-Path $PSScriptRoot 'app\build\outputs\apk\release\app-release-unsigned.apk'
if (-not (Test-Path $aab)) { throw 'Önce derleme yapılmalı (Claude yapar). app-release.aab bulunamadı.' }
function Duz($s) { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
$s1 = Duz (Read-Host 'Anahtar şifresi (en az 8 karakter)' -AsSecureString)
if (-not (Test-Path $ks)) {
  $s2 = Duz (Read-Host 'Şifreyi tekrar yaz' -AsSecureString)
  if ($s1 -ne $s2 -or $s1.Length -lt 8) { throw 'Şifreler uyuşmuyor ya da 8 karakterden kısa.' }
  & "$bin\keytool.exe" -genkeypair -keystore $ks -storetype PKCS12 -alias cini -keyalg RSA -keysize 2048 -validity 10000 -storepass $s1 -keypass $s1 -dname 'CN=Cini Salonu, C=TR'
  if ($LASTEXITCODE -ne 0) { throw 'Anahtar oluşturulamadı.' }
  Write-Host 'upload.keystore oluşturuldu. Yedeklemeyi unutma.'
}
$env:CINI_KS = $s1
$cikti = Join-Path $PSScriptRoot 'cikti'; New-Item -ItemType Directory -Force $cikti | Out-Null
Copy-Item $aab "$cikti\cini-salonu.aab" -Force
& "$bin\jarsigner.exe" -keystore $ks -storepass:env CINI_KS -keypass:env CINI_KS -sigalg SHA256withRSA -digestalg SHA-256 "$cikti\cini-salonu.aab" cini | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'İmzalanamadı: şifre yanlış olabilir.' }
$bt = Get-ChildItem "$env:LOCALAPPDATA\Android\Sdk\build-tools" -Directory | Sort-Object Name -Descending | Select-Object -First 1
if ($bt -and (Test-Path $apk)) {
  & "$($bt.FullName)\zipalign.exe" -f -p 4 $apk "$cikti\hizali.apk"
  & "$($bt.FullName)\apksigner.bat" sign --ks $ks --ks-key-alias cini --ks-pass env:CINI_KS --key-pass env:CINI_KS --out "$cikti\cini-salonu.apk" "$cikti\hizali.apk"
  Remove-Item "$cikti\hizali.apk" -ErrorAction SilentlyContinue
}
Remove-Item Env:\CINI_KS
& "$bin\keytool.exe" -list -v -keystore $ks -storepass $s1 | Select-String 'SHA256:' | Out-File "$cikti\parmak-izi.txt" -Encoding utf8
Write-Host 'Bitti. Dosyalar:' ; Get-ChildItem $cikti | Select-Object Name, Length
Write-Host 'Claude''a "imzaladım" yaz.'
