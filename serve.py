#!/usr/bin/env python3
"""開発用の簡易サーバー。

`python -m http.server` との違いは1点だけ: 毎回のレスポンスに
`Cache-Control: no-store` を付けて、ブラウザ側のキャッシュを完全に無効化します。

`python -m http.server` はキャッシュ関連のヘッダーを一切送らないため、
ブラウザが独自の判断（ヒューリスティックキャッシュ）でJS/CSSファイルを
キャッシュしてしまうことがあり、「ファイルを書き換えたのにブラウザに
反映されない」という非常に紛らわしい問題の原因になります
（サービスワーカーのキャッシュとは別の、ブラウザ標準のHTTPキャッシュの話です）。

使い方は http.server と同じです:
    python serve.py            # ポート8080で起動
    python serve.py 3000       # ポート3000で起動
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"ポート番号が不正です: {sys.argv[1]}")
            sys.exit(1)

    server = HTTPServer(("", port), NoCacheRequestHandler)
    print(f"StreamViewer を http://localhost:{port} で起動しました（キャッシュ無効化モード）")
    print("終了するには Ctrl+C を押してください。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n停止しました。")


if __name__ == "__main__":
    main()
