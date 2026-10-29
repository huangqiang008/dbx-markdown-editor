import { getUniqueId, loadImage } from '../../../utils'
import { sanitize } from '../../../utils'
import { insertAfter, operateClassName } from '../../../utils/domManipulate'
import { CLASS_OR_ID, PREVIEW_DOMPURIFY_CONFIG } from '../../../config'

export default function loadImageAsync (imageInfo, attrs, className, imageClass) {
  const { src, isUnknownType } = imageInfo
  let id
  let isSuccess
  let w
  let h
  let domsrc
  let bitmap
  let pixelData
  let svgText

  let reload = false
  if (this.loadImageMap.has(src)) {
    const imageInfo = this.loadImageMap.get(src)
    if (imageInfo.dispMsec !== imageInfo.touchMsec) {
      // We have a cached image, but force it to load.
      reload = true
    }
  } else {
    reload = true
  }
  if (reload) {
    id = getUniqueId()
      loadImage(src, isUnknownType)
      .then(({ url, width, height, bitmap: loadedBitmap, pixelData: loadedPixelData, svgText: loadedSvgText }) => {
        const imageText = document.querySelector(`#${id}`)
        const image = loadedSvgText
          ? document.createElement('div')
          : (loadedBitmap || loadedPixelData ? document.createElement('canvas') : document.createElement('img'))
        let dispMsec = Date.now()
        let touchMsec = dispMsec
        if (!loadedBitmap && /^file:\/\//.test(src) && !/^data:/.test(url)) {
          domsrc = url + '?msec=' + dispMsec
        } else if (!loadedBitmap) {
          domsrc = url
        }
        if (loadedSvgText) {
          image.setAttribute('role', 'img')
          image.setAttribute('data-image-svg', 'true')
          if (attrs.alt) image.setAttribute('aria-label', attrs.alt.replace(/[`*{}[\]()#+\-.!_>~:|<>$]/g, ''))
          image.innerHTML = sanitize(loadedSvgText, PREVIEW_DOMPURIFY_CONFIG, false)
          const svg = image.firstElementChild
          if (!svg || svg.tagName.toLowerCase() !== 'svg') throw new Error('SVG image is invalid')
        } else if (loadedBitmap || loadedPixelData) {
          image.width = width
          image.height = height
          image.setAttribute('role', 'img')
          image.setAttribute('data-image-canvas', 'true')
          if (attrs.alt) image.setAttribute('aria-label', attrs.alt.replace(/[`*{}[\]()#+\-.!_>~:|<>$]/g, ''))
          const context = image.getContext('2d')
          if (!context) throw new Error('Canvas 2D context is unavailable')
          if (loadedBitmap) {
            context.drawImage(loadedBitmap, 0, 0, width, height)
          } else {
            const imageData = context.createImageData(width, height)
            imageData.data.set(loadedPixelData)
            context.putImageData(imageData, 0, 0)
          }
        } else {
          image.src = domsrc
          if (attrs.alt) image.alt = attrs.alt.replace(/[`*{}[\]()#+\-.!_>~:|<>$]/g, '')
        }
        if (attrs.title) image.setAttribute('title', attrs.title)
        if (attrs.style) image.setAttribute('style', attrs.style)
        if (attrs.width && typeof attrs.width === 'number') {
          image.setAttribute('width', attrs.width)
        }
        if (attrs.height && typeof attrs.height === 'number') {
          image.setAttribute('height', attrs.height)
        }
        if (imageClass) {
          image.classList.add(imageClass)
        }

        if (imageText) {
          if (imageText.classList.contains('ag-inline-image')) {
            const imageContainer = imageText.querySelector('.ag-image-container')
            const oldImage = imageContainer.querySelector('img, canvas')
            if (oldImage) {
              oldImage.remove()
            }
            imageContainer.appendChild(image)
            imageText.classList.remove('ag-image-loading')
            imageText.classList.add('ag-image-success')
          } else {
            insertAfter(image, imageText)
            operateClassName(imageText, 'add', className)
          }
        }
        if (this.urlMap.has(src)) {
          this.urlMap.delete(src)
        }
        this.loadImageMap.set(src, {
          id,
          isSuccess: true,
          width,
          height,
          dispMsec,
          touchMsec,
          domsrc,
          bitmap: loadedBitmap,
          pixelData: loadedPixelData,
          svgText: loadedSvgText
        })
      })
      .catch((err) => {
        console.error('[md-editor] image load failed:', src, err)
        const imageText = document.querySelector(`#${id}`)
        if (imageText) {
          const detail = err && err.message ? `：${err.message}` : ''
          const reason = `图片加载失败${detail}`
          imageText.setAttribute('title', reason)
          operateClassName(imageText, 'remove', CLASS_OR_ID.AG_IMAGE_LOADING)
          operateClassName(imageText, 'add', CLASS_OR_ID.AG_IMAGE_FAIL)
          const image = imageText.querySelector('img, canvas')
          if (image) {
            image.alt = reason
            image.removeAttribute('src')
          }
        }
        if (this.urlMap.has(src)) {
          this.urlMap.delete(src)
        }
        this.loadImageMap.set(src, {
          id,
          isSuccess: false
        })
      })
  } else {
    const imageInfo = this.loadImageMap.get(src)

    id = imageInfo.id
    isSuccess = imageInfo.isSuccess
    w = imageInfo.width
    h = imageInfo.height
    domsrc = imageInfo.domsrc
    bitmap = imageInfo.bitmap
    pixelData = imageInfo.pixelData
    svgText = imageInfo.svgText
  }

  return { id, isSuccess, domsrc, width: w, height: h, bitmap, pixelData, svgText }
}
