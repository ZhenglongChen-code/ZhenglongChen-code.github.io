---
layout: homepage
title: Blog
permalink: /blog/
---

## <i class="fas fa-blog"></i> Blog

{% for post in site.posts %}
<div style="margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #eee;">
<h3><a href="{{ post.url | relative_url }}" style="color:#043361; text-decoration:none;">{{ post.title }}</a></h3>
<p style="color:#888; font-size:0.9em; margin:5px 0;">
<i class="fas fa-calendar-alt"></i> {{ post.date | date: "%Y-%m-%d" }}
{% if post.categories %}&nbsp;·&nbsp; <i class="fas fa-folder"></i> {{ post.categories | join: ", " }}{% endif %}
</p>
{{ post.excerpt | strip_html | truncatewords: 50 }}
<a href="{{ post.url | relative_url }}" style="color:#39c; font-size:0.9em;">阅读全文 &rarr;</a>
</div>
{% endfor %}

{% if site.posts.size == 0 %}
<em style="color:#888;">No posts yet. Coming soon!</em>
{% endif %}
