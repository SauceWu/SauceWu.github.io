---
date: 2018-02-10T15:00:00-00:00
tags: [android,fragment]
title: "Fragment 踩坑实录"
---



@(四大组件)

# Fragment 踩坑实录
### 不要轻易使用commitNowAllowingStateLoss
在很多情况下使用不正确使用Fragment 会导致 java.lang.IllegalStateException 网上很多推荐commitNowAllowingStateLoss 来治标
但使用commitNowAllowingStateLoss 会导致当前Fragment 以其子Fragment 丢失状态 如 getVisibility() isHidden() 等等 而且会出现很多不可预知的问题

出现问题:
- 1 在不正确的时机commit 如 onActivityResult 回调方法中
fragmentManager的 commit方法只能在onResume-onPause 的状态中使用 
如必须在其他状态下改变状态 建议将状态记录下来 在onResume中执行操作
- 2 重复add 同一个Fragment
 由于commit属于异步操作 可能由于commit 过快导致 判断fragment是否为空的方法失效
 应先使用executePendingTransactions让上一次commit执行完成后再执行新的操作
	
   



### 不要在初始化方法中直接生成新的Fragment 
在很多Activity 被重建的情况下 直接生成新的Fragment 会导致旧Fragment 无法回收导致泄露 如果在这些fragment中还有轮训或者socket 回调会导致崩溃
解决方案:
为每个Fragment添加tag
使用findFragmentByTag() 获取Fragment 若为null 再创建新的Fragment