#!/usr/bin/env python3
import importlib.util
import json
import sys
import time


def load_scraper(script_path):
    spec = importlib.util.spec_from_file_location("boss_cdp_raw", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load scraper script: {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if len(sys.argv) != 3:
        print("Usage: diagnose-boss-scraper.py <boss_cdp_raw.py> <cdp-port>", file=sys.stderr)
        return 2

    scraper = load_scraper(sys.argv[1])
    cdp_port = int(sys.argv[2])
    cdp = scraper.CDPSession(cdp_port)
    target_id = ""
    try:
        created = cdp.send("Target.createTarget", {"url": "https://www.zhipin.com/web/user/"})
        target_id = created["result"]["targetId"]
        attached = cdp.send("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        session_id = attached["result"]["sessionId"]
        time.sleep(4)

        href = cdp.eval_js("location.href", session_id) or ""
        title = cdp.eval_js("document.title", session_id) or ""
        text = cdp.eval_js("document.body ? document.body.innerText.slice(0, 500) : ''", session_id) or ""

        probe_url = scraper.build_login_probe_url("Java", "101020100")
        payload = cdp.eval_js(f"""
        (function(){{
            var xhr = new XMLHttpRequest();
            xhr.open('GET', '{probe_url}', false);
            xhr.send();
            return JSON.stringify({{
                status: xhr.status,
                text: xhr.responseText.slice(0, 1200)
            }});
        }})()
        """, session_id)

        status = 0
        api_code = None
        api_message = ""
        try:
            response = json.loads(payload or "{}")
            api_text = json.loads(response.get("text") or "{}")
            api_code = api_text.get("code")
            api_message = api_text.get("message") or ""
            status = response.get("status") or 0
        except Exception:
            pass

        print()
        print("BOSS CDP 诊断：")
        print(f"- 当前页面：{title} / {href}")
        print(f"- 搜索 API：HTTP {status}, code={api_code}, message={api_message or '空'}")

        if "职位管理" in text or "推荐牛人" in text or "牛人管理" in text:
            print("- 识别到当前是 BOSS 招聘端页面。boss-zhipin-scraper 调用的是求职者端职位搜索 API，招聘端账号通常不能通过它抓岗位薪资。")

        if api_code == 37 or "环境" in api_message:
            print("- BOSS 返回“环境异常”。这不是 CDP 端口问题，也不是 WSL 转发问题；是 BOSS 搜索 API 没有给当前浏览器环境返回职位数据。")
            print("- 建议：在这个专用 Chrome 里打开 https://www.zhipin.com/web/geek/job?query=Java&city=101020100 ，切到/登录求职者身份并完成可能出现的验证，再重新运行 pnpm boss-scraper:check。")
        elif api_code not in (0, None):
            print("- BOSS 搜索 API 已响应但未返回可用职位数据，请在专用 Chrome 中手动打开职位搜索页确认是否能看到岗位和明文薪资。")
    finally:
        if target_id:
            cdp.send("Target.closeTarget", {"targetId": target_id})
        cdp.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
