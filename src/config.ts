export const SITE = {
  website: "https://blog-five-pi-20.vercel.app/",
  author: "王奥运",
  profile: "https://github.com/aLittlecrocodile",
  desc: "Go 后端开发 · 技术笔记",
  title: "奥运的 Blog",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 6,
  postPerPage: 8,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  editPost: {
    enabled: false,
    text: "Edit page",
    url: "https://github.com/",
  },
  dynamicOgImage: true,
  dir: "ltr",
  lang: "zh-CN",
  timezone: "Asia/Shanghai",
} as const;
