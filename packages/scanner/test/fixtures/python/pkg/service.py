# 中文：固定解析基准，不执行代码。
def add(x: int = 1, y: int = 2) -> int:
    """Add two annotated values."""
    return x + y

class Service:
    @staticmethod
    def value(n: int = 1) -> int:
        return add(n)
    @classmethod
    def create(cls):
        return cls()

def outer():
    def inner():
        return add()
    return inner()
