---
date: 2020-04-02T20:00:00-00:00
tags: [VPS,Service,denyhost,"file2ban"]
title: "VPS  被暴力尝试登录的几种解决方案"
---



#  VPS  被暴力尝试登录的几种解决方案

[toc]

## 背景

最近登录自己blog的服务器时偶然发现

```` There were 34176 failed login attempts since the last successful login.````

被人扫到了端口 还被疯狂尝试登录 虽然这个破服务器没什么东西 但被破解出来被黑产拉去挖矿什么的也是有点难受的

首先先看一下到底是谁在扫我的机器 

``` bash
# lastb
```



## 解决方案

### 1.denyhost

一顿google之后 被安利了denyhost这个python脚本 原理就是通过它会分析sshd的日志文件（/var/log/secure），当发现重复的攻击时就会记录IP到/etc/hosts.deny文件，从而达到自动屏IP的功能

#### install python3

``` dnf search python36 ```
``` dnf info python36 ```

#### install denyhost

``` git clone https://github.com/denyhosts/denyhosts.git```
``` python3 setup insatll ```
``` cp daemon-control-dist daemon-control``` 

```
###############################################
#### Edit these to suit your configuration ####
###############################################

DENYHOSTS_BIN   = "/usr/bin/denyhosts.py"
DENYHOSTS_LOCK  = "/var/lock/subsys/denyhosts"
DENYHOSTS_CFG   = "/etc/denyhosts.conf"
```

```# chown root daemon-control```

``` # chmod 700 daemon-control ```
```
/usr/bin/python3
```

### 2.file2ban

原理和上面的denyhost 一样 区别是。。file2ban 可以直接yum install。不需要自己编译 而且自定义功能更强大

```
#dnf install epel-release
```
```
yum install file2ban 
```
```
systemctl start fail2ban
```
```
fail2ban status
```
```
[DEFAULT]

ignoreip = 192.168.56.2/24

bantime = 21600

findtime = 300

maxretry = 3

banaction = iptables-multiport

backend = systemd

[sshd]

enabled = true
```