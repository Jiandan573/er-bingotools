"""在本机终端填写 QQ 凭证；密钥不回显、不发送给助手。"""
import getpass
import json
import os
from pathlib import Path
import secrets

path = Path(__file__).with_name(".local-config.json")
config = json.loads(path.read_text()) if path.exists() else {}
print("凭证只保存在本机 .local-config.json。直接回车保留已有值。")
app_id = input("QQ_APP_ID: ").strip()
if app_id:
    config["QQ_APP_ID"] = app_id
app_secret = getpass.getpass("QQ_APP_SECRET（输入不显示）: ").strip()
if app_secret:
    config["QQ_APP_SECRET"] = app_secret
group = input("QQ_GROUP_OPENID（第一次留空，收到群事件后再填）: ").strip()
if group:
    config["QQ_GROUP_OPENID"] = group
if not config.get("QQ_APP_ID") or not config.get("QQ_APP_SECRET"):
    raise SystemExit("AppID 和 AppSecret 必须填写；配置未保存。")
config.setdefault("BOT_CLIENT_KEY", secrets.token_urlsafe(32))
config.update(QQ_EVENTS_ENABLED="true", HOST="127.0.0.1")
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as output:
    json.dump(config, output, ensure_ascii=False, indent=2)
print("配置已保存。运行 npm start 启动；另开终端运行 npm run status 查看群标识。")
print("网页连接地址：http://localhost:8787")
print("网页的客户端密钥可在本地配置文件 BOT_CLIENT_KEY 字段中复制，不要公开该文件。")
