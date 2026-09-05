# Fusion boundary

`apps/dashboard` is the only browser/API host and the only authentication authority. Website remains an independent application. Monitoring provider clients and worker code run server-side only. The monitoring web application and its `fm_session` authentication are not deployed as a second public app.

The first deployment uses `http://149.88.85.240`. The canonical production origins are `https://dashboard.frontmind.cn` for the dashboard and `https://www.frontmind.cn` for the website.
