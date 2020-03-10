---
date: 2020-03-10T20:00:00-00:00
tags: [android,webview]
title: "WebView实现离线缓存"
---



# WebView实现离线缓存

### 场景

在App在长期发展之中，对动态性要求很高的 活动页面 或是 一些带有简单功能的详情页面都可能会有大量Webview使用的情况。但是webview初始化时极有可能遇到网络波动的影响导致加载不出 或者 会重复下载一些公共资源造成性能问题。这时我们希望有一种缓存方案能够暂时解决这些初始化变慢的问题

### 原理

android  WebViewClient提供了shouldInterceptRequest的接口供我们使用这个接口会拦截webview所有请求。如果错误缓存了资源，可能会出现web页面无法更新的情况。所以用的时候要谨慎只对我们需要使用缓存的部分进行拦截 

```kotlin
override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
    if (view != null && request != null) {
      //判断需要使用缓存的url 
        if (WebViewCacheUtils.needCache(request.url.toString())) {
          //从缓存池中获取缓存
            val cache = WebViewCacheUtils.getCache(request)
            if (cache != null) {
                return cache
            }
        }
    }
		//未找到缓存文件或者不需要缓存 还是正常走请求
    return super.shouldInterceptRequest(view, request)
}
```



```kotlin
  fun getCache(webResourceRequest: WebResourceRequest): WebResourceResponse? {
        val uri = webResourceRequest.url
        try {
            //获取加载资源类型
            var mimeType: String? = MimeTypeMapUtils.getMimeTypeFromUrl(uri.toString())
            val type: String
            val header = HashMap<String, String>()
          //我们可能对多个域名进行缓存 先设置跨域
            header["Access-Control-Allow-Origin"] = "*"
            header["Access-Control-Allow-Headers"] = "Content-Type"
            if (mimeType == null) {
                if (uri.path!!.contains("js")) {
                    type = "js"
                    mimeType = "application/javascript"
                    header["content-type"] = "application/javascript; charset=utf-8"
                } else {
                    mimeType = "text/html"
                    type = "html"
                    header["content-type"] = "text/html; charset=utf-8"
                }

            } else if (mimeType.contains("img") || mimeType.contains("image")) {
                type = "img"
            } else {
              //这里主要是css 格式是 text/css
                type = mimeType.split("/".toRegex()).dropLastWhile { it.isEmpty() }.toTypedArray()[1]
            }
//确定是否获取了资源类型
            if (!TextUtils.isEmpty(mimeType)) {
                val name = (if (type == "html") {
                  //由于多个url可能使用的是同一个html 这里需要判断下 返回的是 该html的md5
                    needCacheHtml(uri.path)
                } else {
                    MD5Utils.encode(uri.path)
                })
              //从缓存池中获取缓存 
              val cacheSteam=getWebCache(name, type)
              //构造响应体 并返回
             return  WebResourceResponse(mimeType, "", 200, "ok", header, cacheSteam)
            }
        } catch (e: FileNotFoundException) {
           e.printStackTrace()
        }

        return null
    }
```

### 注意事项

- HTML的缓存一定要小心 最好是由前端同学出一份目录 的接口并且做好版本管理 防止误操作 否则线上可能会出严重问题
- 存储的文件名都是用md5过的 防止有特殊字符影响持久化
- 如果有大文件缓存 最好需要有文件完整性验证 