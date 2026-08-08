import dotenv from 'dotenv';
dotenv.config();

/**
 * Call the selected LLM provider with a prompt.
 * 
 * @param {Object} params
 * @param {string} params.provider - 'gemini' | 'ollama' | 'anthropic' | 'deepseek' | 'mistral' | 'openai'
 * @param {string} [params.apiKey] - Client-supplied API key.
 * @param {string} [params.baseUrl] - Custom base URL for Ollama or OpenAI-compatible APIs.
 * @param {string} [params.model] - Model name.
 * @param {string} params.prompt - The text prompt.
 * @returns {Promise<string>} The generated text.
 */
export async function callLLM({ provider, apiKey, baseUrl, model, prompt }) {
  if (provider === 'gemini') {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('Gemini API-nøgle mangler. Tilføj den i indstillingerne eller i .env.');
    }
    const targetModel = model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${key}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`Gemini API fejl: ${errData.error?.message || `HTTP ${response.status}`}`);
    }
    
    const data = await response.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) throw new Error('Intet svar fra Gemini.');
    return txt;

  } else if (provider === 'ollama') {
    const base = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const url = `${base}/api/generate`;
    const targetModel = model || 'llama3';
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: targetModel,
        prompt: prompt,
        stream: false
      })
    });
    
    if (!response.ok) {
      throw new Error(`Ollama API fejl (Status ${response.status}). Tjek om Ollama kører.`);
    }
    
    const data = await response.json();
    const txt = data.response;
    if (!txt) throw new Error('Intet svar fra Ollama.');
    return txt;

  } else if (provider === 'anthropic') {
    const key = apiKey || process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error('Claude/Anthropic API-nøgle mangler. Tilføj den i indstillingerne eller i .env.');
    }
    const targetModel = model || 'claude-3-5-sonnet-20241022';
    const url = 'https://api.anthropic.com/v1/messages';
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: targetModel,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`Claude API fejl: ${errData.error?.message || `HTTP ${response.status}`}`);
    }
    
    const data = await response.json();
    const txt = data.content?.[0]?.text;
    if (!txt) throw new Error('Intet svar fra Claude.');
    return txt;

  } else if (provider === 'deepseek') {
    const key = apiKey || process.env.DEEPSEEK_API_KEY;
    if (!key) {
      throw new Error('DeepSeek API-nøgle mangler. Tilføj den i indstillingerne eller i .env.');
    }
    const targetModel = model || 'deepseek-chat';
    const url = 'https://api.deepseek.com/v1/chat/completions';
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });
    
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`DeepSeek API fejl: ${errData.error?.message || `HTTP ${response.status}`}`);
    }
    
    const data = await response.json();
    const txt = data.choices?.[0]?.message?.content;
    if (!txt) throw new Error('Intet svar fra DeepSeek.');
    return txt;

  } else if (provider === 'mistral') {
    const key = apiKey || process.env.MISTRAL_API_KEY;
    if (!key) {
      throw new Error('Mistral API-nøgle mangler. Tilføj den i indstillingerne eller i .env.');
    }
    const targetModel = model || 'mistral-tiny';
    const url = 'https://api.mistral.ai/v1/chat/completions';
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });
    
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`Mistral API fejl: ${errData.error?.message || `HTTP ${response.status}`}`);
    }
    
    const data = await response.json();
    const txt = data.choices?.[0]?.message?.content;
    if (!txt) throw new Error('Intet svar fra Mistral.');
    return txt;

  } else if (provider === 'openai') {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key && !baseUrl) {
      throw new Error('OpenAI API-nøgle mangler. Tilføj den i indstillingerne eller i .env.');
    }
    const targetModel = model || 'gpt-4o-mini';
    const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const url = `${base}/chat/completions`;
    
    const headers = { 'Content-Type': 'application/json' };
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });
    
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`OpenAI-kompatibel API fejl: ${errData.error?.message || `HTTP ${response.status}`}`);
    }
    
    const data = await response.json();
    const txt = data.choices?.[0]?.message?.content;
    if (!txt) throw new Error('Intet svar fra OpenAI-kompatibel API.');
    return txt;

  } else {
    throw new Error(`Ukendt LLM provider: ${provider}`);
  }
}
