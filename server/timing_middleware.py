"""
Timing middleware for measuring HTTP request durations.

Adds X-Duration-Ms header to all responses and logs slow requests.
This enables performance monitoring and regression detection.
"""

import time
import logging
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

logger = logging.getLogger(__name__)


class TimingMiddleware(BaseHTTPMiddleware):
    """
    Add timing headers and logging to all HTTP requests.

    Features:
    - Adds X-Duration-Ms header to every response
    - Logs requests with DEBUG level
    - Warns on slow requests (>threshold ms)
    - Uses perf_counter for high-precision timing
    """

    def __init__(self, app, slow_request_threshold_ms: float = 1000.0):
        super().__init__(app)
        self.slow_request_threshold_ms = slow_request_threshold_ms

    async def dispatch(self, request: Request, call_next) -> Response:
        start_time = time.perf_counter()

        # Process request
        response = await call_next(request)

        # Calculate duration
        duration_ms = (time.perf_counter() - start_time) * 1000

        # Add timing header
        response.headers["X-Duration-Ms"] = f"{duration_ms:.2f}"

        # Log slow requests
        if duration_ms > self.slow_request_threshold_ms:
            logger.warning(
                f"Slow request: {request.method} {request.url.path} "
                f"took {duration_ms:.2f}ms"
            )
        else:
            logger.debug(
                f"{request.method} {request.url.path}: {duration_ms:.2f}ms"
            )

        return response
