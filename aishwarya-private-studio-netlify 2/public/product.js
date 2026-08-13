(() => {
  const page = document.querySelector('#productPage');
  const id = new URLSearchParams(location.search).get('id');
  const esc = value => String(value || '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const money = value => new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(value || 0);
  const detail = (label, value) => value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '';
  async function load() {
    try {
      const response = await fetch('/.netlify/functions/admin?action=store/products', {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      const data = await response.json();
      const product = (data.products || []).find(item => item.id === id);
      if (!product) throw new Error('This piece is not currently available.');
      page.innerHTML = `<section class="product-detail"><div class="detail-image">${product.image ? `<img src="${product.image}" alt="${esc(product.name)}">` : ''}</div><div class="detail-copy"><p class="eyebrow">${esc(product.category)}</p><h1>${esc(product.name)}</h1><p class="detail-price">${money(product.price)}</p><p class="detail-description">${esc(product.description || 'A considered saree selected for its craft, drape and presence.')}</p><dl class="product-facts">${detail('Fabric',product.fabric)}${detail('Colour',product.colour)}${detail('Blouse',product.blouseDetails)}${detail('Length',product.length)}${detail('Care',product.care)}${detail('Dispatch',product.deliveryEstimate)}</dl><p class="availability">${product.stock > 1 ? `Only ${product.stock} pieces available` : 'Only one piece available'}</p><button class="button detail-add" type="button">Add to bag <span>→</span></button><p class="detail-note">Cash on delivery is available. We will contact you to confirm delivery.</p></div></section>`;
      page.querySelector('.detail-add').onclick = () => {
        const bag = JSON.parse(localStorage.getItem('aishwarya_bag') || '[]');
        const line = bag.find(item => item.id === product.id);
        if (line) line.quantity = Math.min(line.quantity + 1, product.stock); else bag.push({id:product.id,quantity:1});
        localStorage.setItem('aishwarya_bag', JSON.stringify(bag));
        location.href = '/#collections';
      };
    } catch (error) { page.innerHTML = `<div class="not-found"><p class="eyebrow">Aishwarya edit</p><h1>This piece is<br><em>not available.</em></h1><p>${esc(error.message)}</p><a class="button" href="/#collections">Return to collection <span>→</span></a></div>`; }
  }
  load();
})();
