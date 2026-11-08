import pandas as pd
import pytest
from engine import prepare, run_backtest, Config

def sample():
    times=pd.date_range('2026-11-06 14:35Z',periods=8,freq='min')
    return pd.DataFrame({
        'timestamp':times,'ticker':['SPY']*8,'contract':['SPY261106C00770000']*8,
        'option_type':['C']*8,'bid':[.90,1,1.07,1.12,1.25,1.45,1.60,1.68],
        'ask':[1,1.1,1.17,1.22,1.35,1.55,1.70,1.78],
        'spot':[770,770.1,770.2,770.3,770.6,770.9,771.2,771.3],
        'flow_bias':[.7,.75,.8,.9,.9,.9,.9,.9],'volume':[500]*8,
        'flow_observed_at':times})

def test_parse_and_trade():
    a,b,c=run_backtest(sample(),Config(min_premium_acceleration=-1,min_momentum=0.00001))
    assert a['starting_capital']==10000
    assert a['trades']>=0
    assert c.equity.notna().all()

def test_future_flow_rejected():
    x=sample()
    x.loc[0,'flow_observed_at']=x.loc[1,'timestamp']
    with pytest.raises(ValueError,match='lookahead'):
        prepare(x)

def test_quote_cross_rejected():
    x=sample(); x.loc[0,'bid']=2
    with pytest.raises(ValueError,match='bid/ask'):
        prepare(x)

def test_missing_mark_rejected():
    x=sample().drop(columns=['ask'])
    with pytest.raises(ValueError,match='Missing'):
        prepare(x)