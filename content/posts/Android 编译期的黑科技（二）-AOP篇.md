---
date: 2018-03-17T19:00:00-00:00
tags: ["android","aop"]
title: "Android 编译期的黑科技（二）基础篇"
---

@(奇淫技巧)

# Android 编译期的黑科技（二）-AOP篇
## AOP 定义
AOP 是 Aspect Oriented Programming 的缩写，即“面向切面编程”。使用 AOP，可以在编译期间对代码进行动态管理， 以达到统一维护的目的。AOP 是 OOP 编程的一种延续，也是 Spring 框架中的一个重要模块。利用 AOP 可以对业务逻辑 的各个模块进行隔离，从而使得业务逻辑各个部分之间的耦合度降低，提高程序的可重用性，同时提高开发的效率。利用 AOP，我们可以在无浸入的在宿主中插入一些代码逻辑，从而可以实现一些特殊的功能，比如日志埋点、性能监控、动态 权限控制、代码调试等。

### 优点
- 织入的代码都是Java代码没有过多的学习难度
### 缺点
- 无法织入第三方的库
- 由于定义的切点依赖编程语言，该方案无法兼容 Lambda 语法
## 使用
AOP只是个概念的定义有很多库都可以实现。例如Javapoet/AspectJ。使用的方法都很相似这里只介绍Javapoet。
防不胜防来啦这部分会用[InjectExtra](https://github.com/SauceWu/InjectExtra)为例解释
#### 标记需要操作的位置
通常会使用一个注解去表示 也可以对固定方法进行织入
``` java
InjectExtra("data")
    String data;
```
#### 在编译过程中寻找标记
遍历类中所有被注解的元素并生成代码写入
``` java
AutoService(Processor.class)//自动生成javax.annotation.processing.IProcessor 文件
@SupportedSourceVersion(SourceVersion.RELEASE_8)//java版本支持
public class AnnotationProcessor extends AbstractProcessor {
...
 @Override
    public boolean process(Set<? extends TypeElement> annotations, RoundEnvironment roundEnv) {
        mAnnotatedClassMap.clear();
        try {
        //遍历元素找到被标记的方法或变量
           for (Element element : roundEnv.getElementsAnnotatedWith(InjectExtra.class)) {
            ExtraAnnotationProcessor annotatedClass = getAnnotatedClass(element);
            BindExtraField field = new BindExtraField(element);
            annotatedClass.addField(field);
        }
        } catch (IllegalArgumentException e) {
            // stop process
            return true;
        }

        for (ExtraAnnotationProcessor annotatedClass : mAnnotatedClassMap.values()) {
           //将新生成的文件写入
          annotatedClass.generateFinder().writeTo(mFiler);
...
    }
    ...
}
```
### 写入规则

- $L for Literals
- $S for Strings
- $T for Types
```java
        for (BindExtraField field : mFields) {
            // find views
            if (isSubtypeOfType(typeMirror, "android.app.Activity")) {
                injectMethodBuilder.addStatement("Object $N = target.getIntent().getExtras().get($S)", field.getFieldName(), field.getKey());
            } else {
                injectMethodBuilder.addStatement("Object $N = target.getArguments().get($S)", field.getFieldName(), field.getKey());
            }

            injectMethodBuilder.addStatement("if($N!=null)\ntarget.$N = ($T)$N", field.getFieldName(), field.getFieldName(), ClassName.get(field.getFieldType()), field.getFieldName());

        }
```
## 总结
使用AOP方式织入代码可以说是最简单的方式了。没有语言障碍只需把需要的java代码植入就好了。主要缺陷就是必须在原本的代码中显示调用才可以成功使用，无法无痕使用。