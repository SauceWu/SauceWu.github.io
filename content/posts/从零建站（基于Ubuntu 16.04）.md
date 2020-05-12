---
date: 2017-04-14T18:00:00-00:00
tags: ["service","bandwagon","nginx","docker"]
title: "从零建站（基于Ubuntu 16.04）"
---

# 从零建站（基于Ubuntu 16.04）
[TOC]


## 初始化

### 免密登录
+ client生成ssh公钥
>  **ssh-keygen -t rsa -C "xxxxx@xxxxx.com" **
>  Generating public/private rsa key pair...
> 三次回车即可生成 ssh key

+ 将ssh公钥放入service ~/.ssh/authorized_keys 文件下
+ 重新登陆
### Docker 
#### INSTALL Docker
+ 切换为Docker 官方源
>  - sudo apt-get update
>  - sudo apt-get install  \
      apt-transport-https   \
      ca-certificates    \
      curl   \
      software-properties-common
>  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg  | \
   sudo apt-key add -
>  - sudo add-apt-repository \
   "deb [arch=amd64] https://download.docker.com/linux/ubuntu \
   $(lsb_release -cs) \
   stable"

   - Install Docker CE
   >  - sudo apt-get update
   >  - sudo apt-get install docker-ce
   >  - apt-cache madison docker-ce

#### 创建Docker内部网络
没有远程连接mySQL和Redis的需求且link方式连接 容器维护繁琐 使用Docker 内建网络连接 节省端口资源 
 >- docker network create network-mysql
 >- docker network create network-redis
#### MySQL
>- docker run --name sauce-mysql -d  -e MYSQL_ROOT_PASSWORD=<your pwd>  --network network-mysql  --network-alias mysql -v /root/mysql/data:/var/lib/mysql  mysql
#### Redis
>- docker run --name sauce-redis -d --network network-redis --network-alias redis -v /root/redis/data:/data redis
#### Docker ss
```bash
 docker run -dt --name ss -p 23333:23333 mritd/shadowsocks -s "-s 0.0.0.0 -p 23333 -m aes-256-cfb -k <your pwd> --fast-open"
```
#### SSPanel + SSGo
todo

#### WordPress

##### 搭建网站
> - docker run --name sauce-wordpress --network network-mysql -d -e WORDPRESS_DB_PASSWORD=<mysql pwd> -v /etc/letsencryptlive:/etc/letsencryptlive  -p 80:80 -p 443:443 wordpress
##### 使用https
官方workpress容器使用apache2启动网页
- 新建自签名证书或其他可验证证书 放入容器指定目录下
>  - docker  cp /etc/nginx/ssl/ wordpress:/etc/apache2/ssl/
- apache2载入ssl模块
- >   - docker  cp ssl.load  wordpress:/etc/apache2/mods-enabled/

附 配置文件
```bash
LoadModule ssl_module /usr/lib/apache2/modules/mod_ssl.so
```
- 开启443端口配置
>  - docker cp 000-default.conf wordpress:etc/apache2/sites-enabled/
附配置文件

```xml
<VirtualHost *:80>
	ServerAdmin webmaster@localhost
	DocumentRoot /var/www/html
	ErrorLog ${APACHE_LOG_DIR}/error.log
	CustomLog ${APACHE_LOG_DIR}/access.log combined
</VirtualHost>
<VirtualHost *:443>
	ServerName www.example.com
	SSLEngine on
	SSLCertificateFile /etc/letsencrypt/live/域名/cert.pem
	SSLCertificateKeyFile /etc/letsencrypt/live/域名/privkey.pem
</VirtualHost>
```
- wordpress General Settings的 url 配置到https



#### Idea License
idea系的ide可用的证书哦
- 下载 可执行文件 [here](http://blog.lanyus.com/archives/326.html)
- 上传至服务器
> - $ scp -P  < port > ~/Downloads/IntelliJIDEALicenseServer_linux_amd64 root@< your  ip >:~/root/ideaLicenseServer 

- 新建 Dockerfile
``` dockerfile
FROM alpine
MAINTAINER your e-mail
copy ideaLicenseServer /var/
EXPOSE 1027
CMD ["/var/ideaLicenseServer"]
```
- 构建镜像
> - $ docker build -t idealicense .
- 启动镜像
 > - $ docker run -d - - name idealicense -p < your port > :1027  idealicense

### Nginx
#### Install nginx 
>  - $ apt update
>  - $ apt install nginx
#### 使用
开启
 > - $ nginx

关闭
 > - $ ps -ef |grep nginx
 > 找到nginx 的pid
 > - $ kill -QUIT < pid >

#### 配置https

``` json 
server {
     listen 443 ssl;
	 ssl_certificate  /etc/nginx/ssl/$DOMAIN.crt;
	 ssl_certificate_key /etc/nginx/ssl/$DOMAIN.key;
}
```
#### 多端口配置自定义域名 +  配置https
在/etc/nginx/site-available中新建文件


``` json
  server {
    listen   80;
    listen  443 ssl
    server_name xx.你的域名;
    location / {
        proxy_pass http://ip:port;
        proxy_set_header Host $http_host;
 }
} 
```


## 维护
### 快照
经过如此冗长的配置后 肯定不想重做了吧 快使用快照功能保存吧 
搬瓦工自带的控制台中
KiwiVM Extras - snapshot   

ps：快照过程中服务器可能会重启 不要害怕


### 申请ssl证书
在这里我使用的是 let's encrypt的免费证书
要注意的是申请之前要吧占用80端口的进程关掉哦
#### 只需要单域名
``` bash 
sudo docker run -it --rm --name certbot -p 80:80 -p 443:443 -v /etc/letsencrypt:/etc/letsencrypt -v /var/lib/letsencrypt:/var/lib/letsencrypt  certbot/certbot certonly 
```

> - Select the appropriate number [1-2] then [enter] (press 'c' to cancel): 1
> - Enter email address
> 你的邮箱
> - (A)gree/(C)ancel: a
> - (Y)es/(N)o: y
> - Please enter in your domain name(s) (comma and/or space separated)
     www.example.com

在/etc/letsencrypt/live/ 域名目录下已经生成你需要的证书了 有效期三个月 记得更换 
#### 通配符域名
``` bash 
sudo docker run -it --rm --name certbot -p 80:80 -p 443:443 -v /etc/letsencrypt:/etc/letsencrypt -v /var/lib/letsencrypt:/var/lib/letsencrypt  certbot/certbot certonly --preferred-challenges dns --server https://acme-v02.api.letsencrypt.org/directory  --manual --email sauce.wu@hotmial.com 
```
> -  ...
> - Please enter in your domain name(s) (comma and/or space separated)
>   *.example.com
> - Please deploy a DNS TXT record under the name _acme-challenge.域名 with the following value: sasfasdfasdgasdferqw
> - 请登陆你的域名管理商  按照给的配置 添加一个 txt类型的DNS解析 
>  解析生效需要一定时间 不要捉急
生成位置同上

#### 自动更新脚本 acme.sh
##### 安装
``` bash
curl https://get.acme.sh | sh
```

 获取阿里云的 dns-api
``` bash
export Ali_Key="key"
export Ali_Secret="secret"
```


##### 申请证书
```bash
acme.sh  --installcert  -d  saucewu.top   \
        --key-file   /etc/nginx/ssl/saucewu.sauce.key \
        --fullchain-file /etc/nginx/ssl/fullchain.cer \
        --reloadcmd  "service nginx force-reload"


```
acme.sh  --installcert  -d  *.saucewu.top   \
        --key-file   /etc/nginx/ssl/saucewu.top.key \
        --fullchain-file /etc/nginx/ssl/fullchain.cer \
        --reloadcmd  "service nginx force-reload"
```
##### 证书更新
目前证书在 60 天以后会自动更新, 你无需任何操作. 今后有可能会缩短这个时间, 不过都是自动的, 你不用关心.


```