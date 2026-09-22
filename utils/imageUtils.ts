export function truncateImgUrl(url: string | undefined) {
  if (!url) return null;

  // Find the index of .png if not found find the index of .jpg
  let index =
    url?.indexOf(".png") !== -1 ? url?.indexOf(".png") : url?.indexOf(".jpg");

  if (index && index !== -1) {
    // If .png or .jpg is found
    url = url?.slice(0, index + 4); // Slice the string from the start to the index of .png or .jpg plus 4 (the length of .png or .jpg)
  } else {
    // If .png or .jpg is not found
    return url; // Return the original url string
  }

  return url;
}

