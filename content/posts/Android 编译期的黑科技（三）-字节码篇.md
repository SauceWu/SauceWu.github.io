---
date: 2018-04-05T19:00:00-00:00
tags: ["android","aop"]
title: "Android 编译期的黑科技（三）-字节码篇"
---

@(奇淫技巧)

# Android 编译期的黑科技（三）-字节码篇
## 字节码织入
可以绕过编译，直接操作字节码，从而实现代码注入。所以使用 Javassist 的时机就是在构建工具 Gradle 将源 文件编译成 .class 文件之后，在将 .class 打包成 .dex 文件之前。也有两个相当成熟的字节码框架可供使用。使用起来大同小异这节主要介绍ASM

### ASM
ASM 是一个 Java 字节码操控框架。它能被用来动态生成类或者增强既有类的功能。ASM 可以直接产生二进制 class 文件，也可以在类被加载入 Java 虚拟机之前动态改变类行为。Java class 被存储在严格格式定义的 .class 文件里，这些类文件拥有足够的元数据来解析类中的所有元素：类名称、方法、属性以及 Java 字节码（指令）。ASM 从类文件中读入信息后，能够改变类行为，分析类信息，甚至能够根据用户要求生成新类。
### Javaassist
java 字节码以二进制的形式存储在 .class 文件中，每一个 .class 文件包含一个 Java 类或接口。Javaassist 就是一个用来 处理 Java 字节码的类库。它可以在一个已经编译好的类中添加新的方法，或者是修改已有的方法，并且不需要对字节码方面有深入的了解。与ASM的主要区别在于不能生成新类

#### 优点
- 功能强大 几乎能完成所有需求
#### 缺点
- 需要对字节码有一定了解  有一定技术壁垒
### 使用
#### 依赖
AMS 是以插件形式被引用到项目中的 最简单的方式莫过于写在 buildSrc文件夹中 会自动被Gradle识别为插件
#### 具体使用
在这里会用一个简单的Hook  View.onClickListener() 的例子来讲解用法
完整的demo请点这里 [ASMDemo](https://github.com/SauceWu/AMSDemo)

#### Plugin
首先要注册到Gradle Transform的回调中
``` groovy
 class AsmTran implements Plugin<Project> {

    @Override
    void apply(Project project) {
        AppExtension appExtension = project.extensions.findByType(AppExtension.class)
        appExtension.registerTransform(new ClickTransform())
    }
}
```
#### Transform
确定要对哪些类进行处理 Android中通常要排除R文件以及androidSDK
``` groovy
class ClickTransform extends Transform {
 @Override
    void transform(TransformInvocation transformInvocation) {
        transformInvocation.inputs.each {
            TransformInput input ->
                input.directoryInputs.each {
                    DirectoryInput directoryInput ->
                   //                  dir.traverse(type: FileType.FILES, nameFilter: ~/.*\.class/) {
                            File inputFile ->
                                waitableExecutor.execute(new Callable<Object>() {
                                    @Override
                                    Object call() throws Exception {
                                        File modified = modifyClassFile(dir, inputFile, context.getTemporaryDir())
                                        if (modified != null) {
                                            File target = new File(inputFile.absolutePath.replace(srcDirPath, destDirPath))
                                            if (target.exists()) {
                                                target.delete()
                                            }
                                            FileUtils.copyFile(modified, target)
                                            modified.delete()
                                        }
                                        return null
                                    }
                                })
                        }
                       
                        }}}
 
    }
}
```
#### ClassVisitor
重头戏来了  在这个类里会进行具体.class的解析  确定那个方法会被织入
``` groovy
class ClickClassVisitor extends ClassVisitor implements Opcodes {
...

...
//扫描方法
    @Override
    MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {

        MethodVisitor methodVisitor = cv.visitMethod(access, name, descriptor, signature, exceptions)
        String nameDesc = name + descriptor

        if (nameDesc == 'onClick(Landroid/view/View;)V') {
            println("插入！")
            methodVisitor = new ClickMethodVisitor(methodVisitor, access, name, descriptor)
        }
        return methodVisitor
    }

    ...
    }
```
#### AdviceAdapter
具体织入的代码会在这里
``` groovy
class ClickMethodVisitor extends AdviceAdapter {
  ...
  //会在实际方法前织入代码
        @Override
        protected void onMethodEnter() {
            super.onMethodEnter()
            methodVisitor.visitVarInsn(ALOAD, 1)
            methodVisitor.visitLdcInsn("log hook")
            methodVisitor.visitLdcInsn("start")
            methodVisitor.visitMethodInsn(INVOKESTATIC, Log, "d", "(Ljava/lang/String;Ljava/lang/String;)I", false)
        }
  //会在实际方法后织入代码
        @Override
        protected void onMethodExit(int opcode) {
            super.onMethodExit(opcode)
            methodVisitor.visitVarInsn(ALOAD, 1)
            methodVisitor.visitMethodInsn(INVOKESTATIC, click, "trackViewOnClick", "(Landroid/view/View;)V", false)
            methodVisitor.visitVarInsn(ALOAD, 1)
            methodVisitor.visitLdcInsn("log hook")
            methodVisitor.visitLdcInsn("end")
            methodVisitor.visitMethodInsn(INVOKESTATIC, Log, "d", "(Ljava/lang/String;Ljava/lang/String;)I", false)

        }
...
    }
```
### 字节码基础
要精通ASM使用最终还是要了解字节码的生成 这里推荐一个插件ASM ByteCode Outline
可以将java 直接转成字节码文件 可以根据需求直接ctrl-c+ctrl-v 是不是很轻松呢
## 总结
字节码织入相对使用AOP生成代码使用难度稍高，至少需要对字节码的转换有一定了解。但是经过短暂学习之后会发现这个方式几乎是无所不能的，非常好用。

