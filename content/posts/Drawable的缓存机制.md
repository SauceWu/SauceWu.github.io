---
date: 2020-05-10T15:00:00-00:00
tags: [android,drawable,cache]
title: "从 setTint 引发的Drawable 的缓存问题"
---

# 从 setTint 引发的Drawable 的缓存问题

这两天在做一个新需求是突然发现 DrawableCompat.setTint()更改drawable 渲染颜色的方法居然是全局生效的。变相说明getResource().getDrawable() 每次取出drawable的时候都是从一个缓存池里面出去的。

### 避免缓存的解决方案

第一反应是clone一个新的对象出来进行修改 但是貌似drawable并没有实现Cloneable的借口0那看来得想想别的办法了

看了一会源码果然google在drawable类中已经给我们提供了一个 mutate方法 看注释看似乎这个方法可以返回一个新的drawable对象

``` java
    /**
     * Make this drawable mutable. This operation cannot be reversed. A mutable
     * drawable is guaranteed to not share its state with any other drawable.
     * This is especially useful when you need to modify properties of drawables
     * loaded from resources. By default, all drawables instances loaded from
     * the same resource share a common state; if you modify the state of one
     * instance, all the other instances will receive the same modification.
     *
     * Calling this method on a mutable Drawable will have no effect.
     *
     * @return This drawable.
     * @see ConstantState
     * @see #getConstantState()
     */
    public @NonNull Drawable mutate() {
        return this;
    }
```

最终的实现是根据不同的drawable类型有不同的实现方式 这里就用bitmapdrawable作为例子  不仅clone了的对象 还禁止了这个对象再次被复制 猜测是为了方式无限clone导致oom

``` java
  /**
     * A mutable BitmapDrawable still shares its Bitmap with any other Drawable
     * that comes from the same resource.
     *
     * @return This drawable.
     */
    @Override
    public Drawable mutate() {
        if (!mMutated && super.mutate() == this) {
            mBitmapState = new BitmapState(mBitmapState);
            mMutated = true;
        }
        return this;
    }
```

### drawable的缓存机制

在ResourcesImpl类中 看到 drawable 是根据 theme 和 density判断是否使用缓存的 大部分的机制缓存注释已经说的很明白了 

- 1 判断是否符合当前dpi
- 2 判断该theme 是否被缓存 有则直接返回
- 3 从预加载的缓存池中取出 有则直接返回（在我们的app中这个直接忽略）
- 4 调用loadDrawableForCookie

Ps ：color 和drawable的缓存都是分开的 

``` java
       @Nullable
    Drawable loadDrawable(@NonNull Resources wrapper, @NonNull TypedValue value, int id,
            int density, @Nullable Resources.Theme theme)
            throws NotFoundException {
        // If the drawable's XML lives in our current density qualifier,
        // it's okay to use a scaled version from the cache. Otherwise, we
        // need to actually load the drawable from XML.
        final boolean useCache = density == 0 || value.density == mMetrics.densityDpi;
···

				// mPreloading值仅在startPreloading及finishPreloading方法中被赋值，根据注释说明这两个方法只会被						zygote进程调用所以我们这里mPreloading始终为false
            // First, check whether we have a cached version of this drawable
            // that was inflated against the specified theme. Skip the cache if
            // we're currently preloading or we're not using the cache.
            if (!mPreloading && useCache) {
                final Drawable cachedDrawable = caches.getInstance(key, wrapper, theme);
                if (cachedDrawable != null) {
                    cachedDrawable.setChangingConfigurations(value.changingConfigurations);
                    return cachedDrawable;
                }
            }

      //这里的TypeValue 是在native层被赋值的。
      // 具体是 /frameworks/base/libs/androidfw/AssetManager2.cpp：GetResource方法 有兴趣的可以看一下 
           final boolean isColorDrawable;
            final DrawableCache caches;
      //这里的key 也就是这里的TypeValuedata其实就是resID
            final long key;
            if (value.type >= TypedValue.TYPE_FIRST_COLOR_INT
                    && value.type <= TypedValue.TYPE_LAST_COLOR_INT) {
                isColorDrawable = true;
                caches = mColorDrawableCache;
                key = value.data;
            } else {
                isColorDrawable = false;
                caches = mDrawableCache;
                key = (((long) value.assetCookie) << 32) | value.data;
            }
      
      
            // Next, check preloaded drawables. Preloaded drawables may contain
            // unresolved theme attributes.
            final Drawable.ConstantState cs;
            if (isColorDrawable) {
                cs = sPreloadedColorDrawables.get(key);
            } else {
                cs = sPreloadedDrawables[mConfiguration.getLayoutDirection()].get(key);
            }

            Drawable dr;
            boolean needsNewDrawableAfterCache = false;
      // 这里预加载池子里没有回 
            if (cs != null) {
       ···
                dr = cs.newDrawable(wrapper);
            } else if (isColorDrawable) {
                dr = new ColorDrawable(value.data);
            } else {
                dr = loadDrawableForCookie(wrapper, value, id, density);
            }
····
        
            // Determine if the drawable has unresolved theme attributes. If it
            // does, we'll need to apply a theme and store it in a theme-specific
            // cache.
            final boolean canApplyTheme = dr != null && dr.canApplyTheme();
            if (canApplyTheme && theme != null) {
              // 如果有theme的特殊配置也会mutate 防止更改缓存中数据
                dr = dr.mutate();
                dr.applyTheme(theme);
                dr.clearMutated();
            }

            // If we were able to obtain a drawable, store it in the appropriate
            // cache: preload, not themed, null theme, or theme-specific. Don't
            // pollute the cache with drawables loaded from a foreign density.
            if (dr != null) {
                dr.setChangingConfigurations(value.changingConfigurations);
                if (useCache) {
                  //缓存资源
                    cacheDrawable(value, isColorDrawable, caches, theme, canApplyTheme, key, dr);
                  // 目前只有 DrawableContainer（主要是帧动画和statedrawable） 需要。 每次重置新的state
                  // 要注意帧动画这玩意一开始就会加载所有的图片 及其容易oom
                    if (needsNewDrawableAfterCache) {
                        Drawable.ConstantState state = dr.getConstantState();
                        if (state != null) {
                            dr = state.newDrawable(wrapper);
                        }
                    }
                }
            }

            return dr;
···
    }
```





``` java
   private void cacheDrawable(TypedValue value, boolean isColorDrawable, DrawableCache caches,
            Resources.Theme theme, boolean usesTheme, long key, Drawable dr) {
        final Drawable.ConstantState cs = dr.getConstantState();
        if (cs == null) {
            return;
        }
//可以忽略preloading部分
        if (mPreloading) {
···
        } else {
            synchronized (mAccessLock) {
              // 在这里存进缓存。
                caches.put(key, theme, cs, usesTheme);
            }
        }
    }
```



