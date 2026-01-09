@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%" || goto :error

set "VENV_DIR=.venv"

if not exist "%VENV_DIR%" (
  python -m venv "%VENV_DIR%" || goto :error
)

call "%VENV_DIR%\Scripts\activate" || goto :error

python -m pip install --upgrade pip || goto :error
pip install -r "%SCRIPT_DIR%requirements.txt" || goto :error

uvicorn app.main:app --host 0.0.0.0 --port 8300 || goto :error

popd

goto :eof

:error
popd
echo.
echo [ERROR] run.bat stopped due to an error.
echo Press any key to close this window.
pause >nul
exit /b %errorlevel%
