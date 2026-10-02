export async function avatarFromFile(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.")
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.")
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("This image could not be opened."))
      image.src = url
    })
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 512
    const context = canvas.getContext("2d")
    if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error("This image could not be opened.")
    const size = Math.min(image.naturalWidth, image.naturalHeight)
    context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 512, 512)
    return canvas.toDataURL("image/webp", 0.9)
  } finally { URL.revokeObjectURL(url) }
}
