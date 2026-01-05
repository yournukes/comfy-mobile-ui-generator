@echo off
setlocal

set VENV_DIR=.venv

if not exist %VENV_DIR% (
  python -m venv %VENV_DIR%
)

call %VENV_DIR%\Scripts\activate

python -m pip install --upgrade pip
pip install -r requirements.txt

uvicorn app.main:app --host 0.0.0.0 --port 8300
