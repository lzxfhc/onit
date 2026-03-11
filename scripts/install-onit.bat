@echo off
chcp 65001 >nul 2>&1
title Onit 安装程序

echo.
echo   ╔═══════════════════════════════════════╗
echo   ║                                       ║
echo   ║       Onit - 安装程序                 ║
echo   ║       You say it. Onit.               ║
echo   ║                                       ║
echo   ╚═══════════════════════════════════════╝
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\Onit"
set "SCRIPT_DIR=%~dp0"

echo   安装目录: %INSTALL_DIR%
echo.

:: 关闭正在运行的 Onit
taskkill /f /im Onit.exe >nul 2>&1

:: 创建安装目录
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

:: 复制文件
echo   → 正在安装文件...
xcopy /E /Y /Q "%SCRIPT_DIR%*" "%INSTALL_DIR%\" >nul 2>&1
if errorlevel 1 (
    echo   ❌ 文件复制失败，请以管理员身份运行。
    pause
    exit /b 1
)

:: 创建桌面快捷方式
echo   → 正在创建桌面快捷方式...
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Onit.lnk'); $s.TargetPath = '%INSTALL_DIR%\Onit.exe'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.Description = 'Onit - Desktop AI Agent'; $s.Save()" >nul 2>&1

:: 创建开始菜单快捷方式
echo   → 正在创建开始菜单快捷方式...
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%START_MENU%\Onit.lnk'); $s.TargetPath = '%INSTALL_DIR%\Onit.exe'; $s.WorkingDirectory = '%INSTALL_DIR%'; $s.Description = 'Onit - Desktop AI Agent'; $s.Save()" >nul 2>&1

echo.
echo   ✅ 安装完成！
echo.
echo   → 正在启动 Onit...
start "" "%INSTALL_DIR%\Onit.exe"

timeout /t 3 /nobreak >nul
exit
