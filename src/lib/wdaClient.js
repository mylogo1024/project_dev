'use strict';

/**
 * 画面坐标 → 设备坐标的换算（纯函数）。
 *
 * 只留这一个函数是有原因的：请求构造搬到了 `electron/wda-requests.js`。
 * 历史上这里也有一份 `buildWda*`，但**主进程根本没法用它** ——
 * 主进程是 CJS，`require()` 一个 ESM 在 Electron 28 的 Node 18 下不可用，
 * 于是主进程内联了另一份。两份端点都写错了，而单测只覆盖了这里这份没被使用的，
 * 结果测试全绿、功能永远不通。**「测了一个平行实现」比没测更危险。**
 *
 * 这个函数留在 ESM 侧是因为渲染层要用它（点击位置在渲染层拿到）。
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 把「画面上的点击位置」换算成「设备坐标」。
 *
 * 这是「点击画面就能操作设备」最关键的一步：画面按 contain 方式缩放后**会留黑边**，
 * 不把黑边扣掉就换算，点左上角会偏，越靠边偏得越多。
 *
 * `options.clamp`（滑动场景专用）：手势终点经常落在媒体区域之外（滑出画面边缘是
 * 自然手势，手机上滑列表就是要滑到屏幕底边），此时按「丢弃手势」处理是错的 ——
 * 那正是「只能点击、不能滑动」的直接根因。开启钳制后，越界点会被拉回媒体区域
 * 边缘再换算，等价于「滑到设备屏幕的最边上」。点击仍用默认行为（点黑边不算点击）。
 *
 * @returns {{x:number,y:number}|null} 未开启钳制时点在黑边上返回 null；几何无效时恒为 null
 */
export function mapPointerToDevice(input = {}, options = {}) {
  const viewWidth = Number(input.viewWidth);
  const viewHeight = Number(input.viewHeight);
  const deviceWidth = Number(input.deviceWidth);
  const deviceHeight = Number(input.deviceHeight);
  let pointerX = Number(input.pointerX);
  let pointerY = Number(input.pointerY);

  const valid = [viewWidth, viewHeight, deviceWidth, deviceHeight]
    .every((value) => Number.isFinite(value) && value >= 0);
  // 指针坐标默认要求非负（画布内）；钳制模式下允许为负 —— 手势终点可以滑出画布左侧
  const pointerValid = Number.isFinite(pointerX) && Number.isFinite(pointerY)
    && (options.clamp || (pointerX >= 0 && pointerY >= 0));
  if (!valid || !pointerValid || !viewWidth || !viewHeight || !deviceWidth || !deviceHeight) return null;

  // contain：等比缩放到刚好装下，多余部分成为黑边
  const scale = Math.min(viewWidth / deviceWidth, viewHeight / deviceHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const drawnWidth = deviceWidth * scale;
  const drawnHeight = deviceHeight * scale;
  const offsetX = (viewWidth - drawnWidth) / 2;
  const offsetY = (viewHeight - drawnHeight) / 2;

  if (options.clamp) {
    // 滑动终点落在黑边/画布外：拉回媒体区域边缘，手势照常执行
    pointerX = Math.min(Math.max(pointerX, offsetX), offsetX + drawnWidth);
    pointerY = Math.min(Math.max(pointerY, offsetY), offsetY + drawnHeight);
  } else {
    if (pointerX < offsetX || pointerX > offsetX + drawnWidth) return null;
    if (pointerY < offsetY || pointerY > offsetY + drawnHeight) return null;
  }

  const x = (pointerX - offsetX) / scale;
  const y = (pointerY - offsetY) / scale;

  return {
    // 设备坐标必须是整数点，且不能越界（右下角差 0.5 就会被系统判为无效）
    x: Math.round(clamp(x, 0, deviceWidth - 1)),
    y: Math.round(clamp(y, 0, deviceHeight - 1))
  };
}
