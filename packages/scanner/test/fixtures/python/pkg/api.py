from .service import add as sum_values
from fastapi import FastAPI
from flask import Flask
app = FastAPI()
web = Flask(__name__)

@app.get("/sum")
async def total(n: int = 1) -> int:
    return sum_values(n)

@web.route("/post", methods=["POST"])
def submit():
    return sum_values()

def dynamic(target):
    return getattr(target, "unknown")()
