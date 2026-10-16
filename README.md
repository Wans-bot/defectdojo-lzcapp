# DefectDojo 的懒猫 LPK 打包仓库

懒猫微服应用 `cloud.lazycat.app.defectdojo` 的打包工程。定时检查上游镜像
`defectdojo/defectdojo-django` 与 `defectdojo/defectdojo-nginx` 的 3.x 版本并自动构建与提审。

- 上游：https://github.com/DefectDojo/django-DefectDojo（BSD-3-Clause）
- 跟随版本的镜像：`defectdojo/defectdojo-django`（uwsgi、celerybeat、celeryworker 三个 service）、
  `defectdojo/defectdojo-nginx`（nginx）
- 不跟随版本：postgres、valkey
- 平台凭据：仓库 Secret `LZC_API_TOKEN`
