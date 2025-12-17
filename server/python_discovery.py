"""
Python Environment Discovery Service
Discovers Python interpreters on the system similar to VS Code
"""
import os
import json
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from concurrent.futures import ThreadPoolExecutor, as_completed

# Cache settings
CACHE_FILE = Path.home() / ".nebula-notebook" / "python-cache.json"
CACHE_TTL_HOURS = 24

@dataclass
class PythonEnvironment:
    """Represents a discovered Python environment"""
    path: str  # Full path to python executable
    version: str  # e.g., "3.11.5"
    display_name: str  # e.g., "Python 3.11.5 (conda: base)"
    env_type: str  # "system", "conda", "pyenv", "venv", "homebrew"
    env_name: Optional[str] = None  # e.g., "base", "myenv"
    has_ipykernel: bool = False
    kernel_name: Optional[str] = None  # If registered as Jupyter kernel


class PythonDiscoveryService:
    """Service for discovering Python environments"""

    def __init__(self):
        self._cache: Dict = {}
        self._cache_time: float = 0
        self._load_cache()

    def _load_cache(self):
        """Load cached Python environments from disk"""
        try:
            if CACHE_FILE.exists():
                with open(CACHE_FILE, 'r') as f:
                    data = json.load(f)
                    self._cache = data.get('environments', {})
                    self._cache_time = data.get('timestamp', 0)
        except Exception as e:
            print(f"Failed to load Python cache: {e}")
            self._cache = {}
            self._cache_time = 0

    def _save_cache(self):
        """Save Python environments to disk cache"""
        try:
            CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(CACHE_FILE, 'w') as f:
                json.dump({
                    'environments': self._cache,
                    'timestamp': time.time()
                }, f, indent=2)
        except Exception as e:
            print(f"Failed to save Python cache: {e}")

    def _is_cache_valid(self) -> bool:
        """Check if cache is still valid"""
        if not self._cache:
            return False
        age_hours = (time.time() - self._cache_time) / 3600
        return age_hours < CACHE_TTL_HOURS

    def _get_python_version(self, python_path: str) -> Optional[str]:
        """Get Python version from executable"""
        try:
            result = subprocess.run(
                [python_path, '--version'],
                capture_output=True,
                text=True,
                timeout=5
            )
            # Output is like "Python 3.11.5"
            version = result.stdout.strip() or result.stderr.strip()
            return version.replace('Python ', '')
        except Exception:
            return None

    def _check_ipykernel(self, python_path: str) -> bool:
        """Check if ipykernel is installed"""
        try:
            result = subprocess.run(
                [python_path, '-c', 'import ipykernel'],
                capture_output=True,
                timeout=10
            )
            return result.returncode == 0
        except Exception:
            return False

    def _find_conda_envs(self) -> List[Dict]:
        """Find conda environments"""
        envs = []

        # Common conda locations
        conda_bases = [
            Path.home() / "anaconda3",
            Path.home() / "miniconda3",
            Path.home() / "miniforge3",
            Path.home() / "mambaforge",
            Path("/opt/anaconda3"),
            Path("/opt/miniconda3"),
            Path("/usr/local/anaconda3"),
            Path("/usr/local/miniconda3"),
        ]

        for base in conda_bases:
            if not base.exists():
                continue

            # Base environment
            base_python = base / "bin" / "python"
            if base_python.exists():
                envs.append({
                    'path': str(base_python),
                    'env_type': 'conda',
                    'env_name': 'base',
                    'base': str(base)
                })

            # Sub-environments
            envs_dir = base / "envs"
            if envs_dir.exists():
                for env_path in envs_dir.iterdir():
                    if env_path.is_dir():
                        python = env_path / "bin" / "python"
                        if python.exists():
                            envs.append({
                                'path': str(python),
                                'env_type': 'conda',
                                'env_name': env_path.name,
                                'base': str(base)
                            })

        return envs

    def _find_pyenv_versions(self) -> List[Dict]:
        """Find pyenv Python versions"""
        envs = []
        pyenv_root = Path.home() / ".pyenv" / "versions"

        if not pyenv_root.exists():
            return envs

        for version_dir in pyenv_root.iterdir():
            if version_dir.is_dir():
                python = version_dir / "bin" / "python"
                if python.exists():
                    envs.append({
                        'path': str(python),
                        'env_type': 'pyenv',
                        'env_name': version_dir.name
                    })

        return envs

    def _find_virtualenvs(self) -> List[Dict]:
        """Find virtualenvs in common locations"""
        envs = []

        # Common virtualenv locations
        venv_dirs = [
            Path.home() / ".virtualenvs",
            Path.home() / "venvs",
            Path.home() / ".venvs",
        ]

        for venv_dir in venv_dirs:
            if not venv_dir.exists():
                continue

            for env_path in venv_dir.iterdir():
                if env_path.is_dir():
                    python = env_path / "bin" / "python"
                    if python.exists():
                        envs.append({
                            'path': str(python),
                            'env_type': 'venv',
                            'env_name': env_path.name
                        })

        return envs

    def _find_system_pythons(self) -> List[Dict]:
        """Find system Python installations"""
        envs = []

        # Common system Python locations
        system_paths = [
            "/usr/bin/python3",
            "/usr/local/bin/python3",
            "/opt/homebrew/bin/python3",  # Apple Silicon Homebrew
            "/usr/local/opt/python/libexec/bin/python",  # Intel Homebrew
        ]

        # Also check PATH
        path_dirs = os.environ.get('PATH', '').split(':')
        for path_dir in path_dirs:
            for name in ['python3', 'python']:
                candidate = Path(path_dir) / name
                if str(candidate) not in system_paths:
                    system_paths.append(str(candidate))

        seen = set()
        for python_path in system_paths:
            path = Path(python_path)
            if not path.exists():
                continue

            # Resolve symlinks to avoid duplicates
            try:
                real_path = str(path.resolve())
                if real_path in seen:
                    continue
                seen.add(real_path)
            except Exception:
                continue

            # Determine type
            env_type = 'system'
            if 'homebrew' in python_path.lower() or '/opt/homebrew' in python_path:
                env_type = 'homebrew'

            envs.append({
                'path': python_path,
                'env_type': env_type,
                'env_name': None
            })

        return envs

    def _enrich_environment(self, env: Dict) -> Optional[PythonEnvironment]:
        """Enrich environment with version and ipykernel info"""
        path = env['path']

        version = self._get_python_version(path)
        if not version:
            return None

        has_ipykernel = self._check_ipykernel(path)

        # Create display name
        env_type = env['env_type']
        env_name = env.get('env_name')

        if env_type == 'conda' and env_name:
            display_name = f"Python {version} (conda: {env_name})"
        elif env_type == 'pyenv' and env_name:
            display_name = f"Python {version} (pyenv: {env_name})"
        elif env_type == 'venv' and env_name:
            display_name = f"Python {version} (venv: {env_name})"
        elif env_type == 'homebrew':
            display_name = f"Python {version} (Homebrew)"
        else:
            display_name = f"Python {version} (System)"

        return PythonEnvironment(
            path=path,
            version=version,
            display_name=display_name,
            env_type=env_type,
            env_name=env_name,
            has_ipykernel=has_ipykernel
        )

    def discover(self, force_refresh: bool = False) -> List[PythonEnvironment]:
        """
        Discover all Python environments on the system
        Uses cache unless force_refresh is True or cache is expired
        """
        if not force_refresh and self._is_cache_valid():
            return [PythonEnvironment(**env) for env in self._cache.values()]

        print("Discovering Python environments...")

        # Collect all candidate environments
        candidates = []
        candidates.extend(self._find_conda_envs())
        candidates.extend(self._find_pyenv_versions())
        candidates.extend(self._find_virtualenvs())
        candidates.extend(self._find_system_pythons())

        # Enrich in parallel for speed
        environments = []
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = {executor.submit(self._enrich_environment, env): env for env in candidates}
            for future in as_completed(futures):
                try:
                    result = future.result()
                    if result:
                        environments.append(result)
                except Exception as e:
                    print(f"Error enriching environment: {e}")

        # Sort by type and name
        type_order = {'conda': 0, 'pyenv': 1, 'venv': 2, 'homebrew': 3, 'system': 4}
        environments.sort(key=lambda e: (type_order.get(e.env_type, 99), e.display_name))

        # Update cache
        self._cache = {env.path: asdict(env) for env in environments}
        self._cache_time = time.time()
        self._save_cache()

        print(f"Discovered {len(environments)} Python environments")
        return environments

    def install_kernel(self, python_path: str, kernel_name: Optional[str] = None) -> Dict:
        """
        Install ipykernel and register as Jupyter kernel
        Returns the kernel spec info
        """
        # Verify Python exists
        if not Path(python_path).exists():
            raise FileNotFoundError(f"Python not found: {python_path}")

        # Install ipykernel if needed
        print(f"Installing ipykernel for {python_path}...")
        result = subprocess.run(
            [python_path, '-m', 'pip', 'install', 'ipykernel', '-q'],
            capture_output=True,
            text=True,
            timeout=120
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to install ipykernel: {result.stderr}")

        # Generate kernel name if not provided
        if not kernel_name:
            # Get version for name
            version = self._get_python_version(python_path) or "3"
            version_short = version.split('.')[0] + '.' + version.split('.')[1] if '.' in version else version

            # Create unique name based on path
            path_hash = abs(hash(python_path)) % 10000
            kernel_name = f"python{version_short}_{path_hash}"

        # Register kernel
        print(f"Registering kernel as {kernel_name}...")
        result = subprocess.run(
            [python_path, '-m', 'ipykernel', 'install', '--user', '--name', kernel_name],
            capture_output=True,
            text=True,
            timeout=60
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to register kernel: {result.stderr}")

        # Update cache entry
        if python_path in self._cache:
            self._cache[python_path]['has_ipykernel'] = True
            self._cache[python_path]['kernel_name'] = kernel_name
            self._save_cache()

        return {
            'kernel_name': kernel_name,
            'python_path': python_path,
            'message': f"Successfully registered kernel '{kernel_name}'"
        }

    def get_cache_info(self) -> Dict:
        """Get information about the cache"""
        return {
            'cached_count': len(self._cache),
            'cache_age_hours': (time.time() - self._cache_time) / 3600 if self._cache_time else None,
            'cache_valid': self._is_cache_valid(),
            'cache_file': str(CACHE_FILE)
        }


# Singleton instance
python_discovery = PythonDiscoveryService()
