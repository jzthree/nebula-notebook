"""
Multi-Provider LLM Service - Supports Gemini, OpenAI, and Anthropic
"""
import os
from typing import Optional, List, Dict, Any
from dataclasses import dataclass
from google import genai
from google.genai import types
from openai import OpenAI
from anthropic import Anthropic


# Available models per provider (updated Dec 2025)
AVAILABLE_MODELS = {
    "google": ["gemini-3.0-flash", "gemini-3.0-pro", "gemini-2.5-flash"],
    "openai": ["gpt-5.2", "gpt-5-mini", "gpt-4o"],
    "anthropic": ["claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251101"]
}


@dataclass
class LLMConfig:
    """Configuration for LLM requests"""
    provider: str
    model: str
    temperature: float = 0.2
    max_tokens: int = 4096


class LLMService:
    """Multi-provider LLM service"""

    def __init__(self):
        self._google_client = None
        self._openai_client = None
        self._anthropic_client = None

    def _get_google_client(self) -> genai.Client:
        """Get or create Google GenAI client"""
        if self._google_client is None:
            api_key = os.getenv("GEMINI_API_KEY")
            if not api_key:
                raise ValueError("GEMINI_API_KEY not found in environment")
            self._google_client = genai.Client(api_key=api_key)
        return self._google_client

    def _get_openai_client(self) -> OpenAI:
        """Get or create OpenAI client"""
        if self._openai_client is None:
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("OPENAI_API_KEY not found in environment")
            self._openai_client = OpenAI(api_key=api_key)
        return self._openai_client

    def _get_anthropic_client(self) -> Anthropic:
        """Get or create Anthropic client"""
        if self._anthropic_client is None:
            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                raise ValueError("ANTHROPIC_API_KEY not found in environment")
            self._anthropic_client = Anthropic(api_key=api_key)
        return self._anthropic_client

    def get_available_providers(self) -> Dict[str, List[str]]:
        """Get available providers and their models based on configured API keys"""
        available = {}

        if os.getenv("GEMINI_API_KEY"):
            available["google"] = AVAILABLE_MODELS["google"]

        if os.getenv("OPENAI_API_KEY"):
            available["openai"] = AVAILABLE_MODELS["openai"]

        if os.getenv("ANTHROPIC_API_KEY"):
            available["anthropic"] = AVAILABLE_MODELS["anthropic"]

        return available

    async def generate(
        self,
        prompt: str,
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """
        Generate a response from the LLM

        Args:
            prompt: User prompt
            system_prompt: System instructions
            config: LLM configuration
            images: Optional list of images [{mime_type, data}]

        Returns:
            Generated text response
        """
        if config.provider == "google":
            return await self._generate_google(prompt, system_prompt, config, images)
        elif config.provider == "openai":
            return await self._generate_openai(prompt, system_prompt, config, images)
        elif config.provider == "anthropic":
            return await self._generate_anthropic(prompt, system_prompt, config, images)
        else:
            raise ValueError(f"Unknown provider: {config.provider}")

    async def _generate_google(
        self,
        prompt: str,
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """Generate using Google Gemini"""
        client = self._get_google_client()

        # Build content parts
        contents = [prompt]

        if images:
            import base64
            for img in images:
                contents.append(types.Part.from_bytes(
                    data=base64.b64decode(img["data"]),
                    mime_type=img.get("mime_type", "image/png")
                ))

        response = client.models.generate_content(
            model=config.model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=config.temperature,
                max_output_tokens=config.max_tokens
            )
        )

        return response.text

    async def _generate_openai(
        self,
        prompt: str,
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """Generate using OpenAI"""
        client = self._get_openai_client()

        messages = [
            {"role": "system", "content": system_prompt}
        ]

        # Build user message content
        if images:
            content = [{"type": "text", "text": prompt}]
            for img in images:
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{img.get('mime_type', 'image/png')};base64,{img['data']}"
                    }
                })
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": prompt})

        response = client.chat.completions.create(
            model=config.model,
            messages=messages,
            temperature=config.temperature,
            max_tokens=config.max_tokens
        )

        return response.choices[0].message.content

    async def _generate_anthropic(
        self,
        prompt: str,
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """Generate using Anthropic Claude"""
        client = self._get_anthropic_client()

        # Build user message content
        if images:
            content = []
            for img in images:
                content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": img.get("mime_type", "image/png"),
                        "data": img["data"]
                    }
                })
            content.append({"type": "text", "text": prompt})
        else:
            content = prompt

        response = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": content}],
            temperature=config.temperature
        )

        return response.content[0].text

    async def chat(
        self,
        message: str,
        history: List[Dict[str, str]],
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """
        Chat with conversation history

        Args:
            message: Current user message
            history: Previous messages [{"role": "user"|"assistant", "content": "..."}]
            system_prompt: System instructions
            config: LLM configuration
            images: Optional images for current message

        Returns:
            Assistant response
        """
        if config.provider == "google":
            return await self._chat_google(message, history, system_prompt, config, images)
        elif config.provider == "openai":
            return await self._chat_openai(message, history, system_prompt, config, images)
        elif config.provider == "anthropic":
            return await self._chat_anthropic(message, history, system_prompt, config, images)
        else:
            raise ValueError(f"Unknown provider: {config.provider}")

    async def _chat_google(
        self,
        message: str,
        history: List[Dict[str, str]],
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """Chat using Google Gemini"""
        client = self._get_google_client()

        # Convert history to Gemini format
        contents = []
        for msg in history:
            role = "user" if msg["role"] == "user" else "model"
            contents.append(types.Content(
                role=role,
                parts=[types.Part.from_text(msg["content"])]
            ))

        # Add current message with images
        current_parts = [types.Part.from_text(message)]
        if images:
            import base64
            for img in images:
                current_parts.append(types.Part.from_bytes(
                    data=base64.b64decode(img["data"]),
                    mime_type=img.get("mime_type", "image/png")
                ))

        contents.append(types.Content(
            role="user",
            parts=current_parts
        ))

        response = client.models.generate_content(
            model=config.model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                temperature=config.temperature,
                max_output_tokens=config.max_tokens
            )
        )

        return response.text

    async def _chat_openai(
        self,
        message: str,
        history: List[Dict[str, str]],
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """Chat using OpenAI"""
        client = self._get_openai_client()

        messages = [{"role": "system", "content": system_prompt}]

        # Add history
        for msg in history:
            messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })

        # Add current message with images
        if images:
            content = [{"type": "text", "text": message}]
            for img in images:
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{img.get('mime_type', 'image/png')};base64,{img['data']}"
                    }
                })
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": message})

        response = client.chat.completions.create(
            model=config.model,
            messages=messages,
            temperature=config.temperature,
            max_tokens=config.max_tokens
        )

        return response.choices[0].message.content

    async def _chat_anthropic(
        self,
        message: str,
        history: List[Dict[str, str]],
        system_prompt: str,
        config: LLMConfig,
        images: Optional[List[Dict[str, str]]] = None
    ) -> str:
        """Chat using Anthropic Claude"""
        client = self._get_anthropic_client()

        messages = []

        # Add history
        for msg in history:
            messages.append({
                "role": msg["role"],
                "content": msg["content"]
            })

        # Add current message with images
        if images:
            content = []
            for img in images:
                content.append({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": img.get("mime_type", "image/png"),
                        "data": img["data"]
                    }
                })
            content.append({"type": "text", "text": message})
            messages.append({"role": "user", "content": content})
        else:
            messages.append({"role": "user", "content": message})

        response = client.messages.create(
            model=config.model,
            max_tokens=config.max_tokens,
            system=system_prompt,
            messages=messages,
            temperature=config.temperature
        )

        return response.content[0].text


# Global instance
llm_service = LLMService()
