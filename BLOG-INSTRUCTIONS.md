# Treehouse Pharmacy Blog — How to Add a New Post

## Quick Steps

### 1. Create the blog post file
- Open the `blog/_TEMPLATE.html` file
- Copy ALL the content
- Create a new file in the `blog/` folder with a URL-friendly name like:
  `blog/your-post-title-here.html`
- Paste the template content and fill in the sections marked with ✏️

### 2. Add it to the blog listing page
- Open `blog.html`
- Find the blog posts section (look for `<!-- POST 1 -->`)
- Copy one of the existing post card blocks (the whole `<a href="..." class="blog-card ...">` block)
- Paste it ABOVE the first post (so newest posts are on top)
- Update the link, title, description, date, and category

### Styles
- Posts use the site's shared stylesheet (`/assets/site/styles.css`), linked at the end of the template's `<head>`; keep that line.
- Stick to the styling classes the template already uses. New Tailwind classes are picked up when the site is deployed;
  to see them locally (or keep the committed stylesheet current), run `npm run css`.

### 3. Upload to GitHub
- Upload both the new blog post file AND the updated `blog.html` to your repo

## SEO Tips
- Include "Ponca City," "Kay County," "Oklahoma," and "Treehouse Pharmacy" naturally in each post
- Write 500-1500 words per post
- Use h2 and h3 headings to break up content
- Keep your title under 60 characters
- Write a compelling meta description (under 155 characters)

## Blog Post Ideas
- Indica vs Sativa: What's the Difference?
- Top 5 Cannabis Strains for Pain Relief
- What Are Terpenes and Why Do They Matter?
- First Time at a Dispensary? Here's What to Expect
- Cannabis Edibles Dosing Guide for Beginners
- Ponca City Events & Community Spotlight posts
- New product announcements and seasonal deals
