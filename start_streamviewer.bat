@echo off
REM StreamViewer 起動用ランチャー (診断ログ付き)
REM   1) ローカルサーバー(serve.py)をバックグラウンドで起動
REM   2) すでにインストール済みのPWAウィンドウ(アドレスバーなし)を開く
REM   3) 起動後、同じ名前のウィンドウが2つ以上あれば余分なものを自動で閉じる（二重起動対策）
REM
REM ※ 同じフォルダに _sv_winhelper.ps1 が必要です（ウィンドウの重複を検出・解消するための補助スクリプト）
REM 途中経過はすべて start_streamviewer.log に記録されます。
REM うまく起動しない場合はこのログの内容を確認してください。

setlocal enabledelayedexpansion
cd /d "%~dp0"
set LOGFILE=%~dp0start_streamviewer.log
set PSHELPER=%~dp0_sv_winhelper.ps1

echo ===== %date% %time% ===== > "%LOGFILE%"
echo [1/6] 作業フォルダ: %cd% >> "%LOGFILE%"

echo [2/6] 既存のStreamViewerウィンドウの数を確認中... >> "%LOGFILE%"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%PSHELPER%" count >> "%LOGFILE%" 2>&1

echo [3/6] python / pythonw の場所を確認中... >> "%LOGFILE%"
where pythonw >> "%LOGFILE%" 2>&1
if errorlevel 1 (
    echo   !! pythonw が見つかりませんでした (PATHが通っていない可能性) >> "%LOGFILE%"
) else (
    echo   OK: pythonw が見つかりました >> "%LOGFILE%"
)
where python >> "%LOGFILE%" 2>&1

echo [4/6] serve.py の存在確認... >> "%LOGFILE%"
if exist "%~dp0serve.py" (
    echo   OK: %~dp0serve.py あり >> "%LOGFILE%"
) else (
    echo   !! serve.py が見つかりません: %~dp0serve.py >> "%LOGFILE%"
)

echo [5/6] サーバーを起動します (pythonw serve.py)... >> "%LOGFILE%"
start "" /min pythonw "%~dp0serve.py"
echo   start コマンド実行完了 (errorlevel=!errorlevel!) >> "%LOGFILE%"

REM サーバー起動を少し待つ
timeout /t 10 /nobreak >> "%LOGFILE%" 2>&1

echo [6/6] StreamViewer アプリウィンドウを開きます... >> "%LOGFILE%"
set CHROME_PROXY=C:\Program Files\Google\Chrome\Application\chrome_proxy.exe
if exist "%CHROME_PROXY%" (
    echo   OK: %CHROME_PROXY% あり >> "%LOGFILE%"
    start "" "%CHROME_PROXY%" --profile-directory=Default --app-id=pojgaalelfclafjbjgnblpejmgnealam
    echo   start コマンド実行完了 (errorlevel=!errorlevel!) >> "%LOGFILE%"
) else (
    echo   !! chrome_proxy.exe が見つかりません: %CHROME_PROXY% >> "%LOGFILE%"
    echo   代わりに通常のChromeでアプリURLを開きます... >> "%LOGFILE%"
    start "" chrome --app=http://localhost:8080/
)

echo [7/7] ウィンドウが2つ以上開いていないか、最大15秒ほど監視して余分なものを閉じます... >> "%LOGFILE%"
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%PSHELPER%" dedupe >> "%LOGFILE%" 2>&1

echo ===== 完了 ===== >> "%LOGFILE%"
echo.
echo StreamViewer を起動しています... (このウィンドウは自動的に閉じます)
echo 問題が起きた場合は start_streamviewer.log を確認してください。
timeout /t 3 >nul